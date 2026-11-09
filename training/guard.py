"""Keeps a long training from cooking Juan's work Mac.

Training runs for hours or days on the same MacBook (M2, 16 GB) Juan works on. Between two PPO
updates, ppo.py asks the guard what to do, and the guard answers with one of three modes:

    full     nobody is using the Mac, it is plugged in and cool: every core trains.
    shared   Juan is using it (a key or the mouse in the last few minutes), the Mac is warm, or
             memory is tight. With the default policy, "background", the training drops to macOS
             background priority (PRIO_DARWIN_BG: on Apple Silicon, the efficiency cores and a
             throttled disk): the Mac stays responsive and cool, and training goes ~8x slower
             (measured on the M2 Air: ~1,300 steps/s against 11,400). With --shared nice, it keeps
             every core at nice 10: apps still come first, training stays fast, the Mac runs warm.
    paused   on battery, the Mac is hot (macOS thermal state "serious" or "critical"), memory is
             critical, or a pause was asked for (`python -m training.guard pause`): the
             training waits, without stepping, until the reason is gone. It never dies: it resumes.

Heat comes from macOS's own judgment, ProcessInfo.thermalState (nominal, fair, serious, critical),
the signal Apple gives apps to back off: the M2 MacBook Air has no fan, so it matters. A 3-line
Swift probe is compiled once into training/runs/ (needs the Xcode command line tools, which this
Mac has); without it, pmset's CPU speed limit is the fallback.

While it trains on power, `caffeinate -i` keeps the Mac from idle-sleeping (only while ppo.py runs,
and never on battery). Everything is read from tools macOS already has (pmset, ioreg, sysctl,
taskpolicy): no sudo, nothing installed, nothing leaves the Mac.

    uv run --project training python -m training.guard status   # what the guard sees now
    uv run --project training python -m training.guard pause    # pause every training
    uv run --project training python -m training.guard resume
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# One flag file for every run: Juan pauses "the training", not a run by name.
PAUSE_FILE = Path.home() / ".tridi-training-pause"

# Juan is "using the Mac" if a key or the pointer moved this recently. 3 min: short enough that the
# Mac is fast again as soon as he sits down, long enough that reading a page is not "idle".
ACTIVE_S = 180
# A hot Mac pauses at least this long once it cools, so it does not flap between hot and cool
# every few seconds right at the limit.
COOL_DOWN_S = 300
# Asking macOS costs a few subprocesses (~30 ms); one update takes ~0.35 s. Every 15 s is cheap and
# still reacts within one sip of coffee.
CHECK_EVERY_S = 15
# While paused, look again this often.
PAUSED_POLL_S = 30


THERMAL_NAMES = ["nominal", "fair", "serious", "critical"]
PROBE = Path(__file__).parent / "runs" / ".thermal-state"
PROBE_SOURCE = "import Foundation\nprint(ProcessInfo.processInfo.thermalState.rawValue)\n"


@dataclass
class Reading:
    on_ac: bool
    battery: int | None
    thermal: int  # ProcessInfo.thermalState: 0 nominal, 1 fair, 2 serious, 3 critical
    idle_s: float
    memory: int  # kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical
    pause_asked: bool

    def mode(self) -> tuple[str, str]:
        if self.pause_asked:
            return "paused", "pause asked (python -m training.guard resume)"
        if not self.on_ac:
            return "paused", f"on battery ({self.battery}%): plug it in to train"
        if self.thermal >= 2:
            return "paused", f"the Mac is hot (thermal state {THERMAL_NAMES[self.thermal]})"
        if self.memory >= 4:
            return "paused", "memory pressure critical"
        if self.idle_s < ACTIVE_S:
            return "shared", f"in use ({self.idle_s:.0f} s since last input): background priority"
        if self.memory >= 2:
            return "shared", "memory pressure warning: background priority"
        if self.thermal == 1:
            return "shared", "the Mac is warm (thermal state fair): background priority"
        return "full", f"idle {self.idle_s / 60:.0f} min, on power, cool"


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def thermal_state() -> int:
    """macOS's thermal state, 0-3. The Swift probe is built on first use (a few seconds, once)."""
    if not PROBE.exists():
        PROBE.parent.mkdir(parents=True, exist_ok=True)
        source = PROBE.with_suffix(".swift")
        source.write_text(PROBE_SOURCE)
        _run(["swiftc", "-O", str(source), "-o", str(PROBE)])
    out = _run([str(PROBE)]).strip() if PROBE.exists() else ""
    if out.isdigit():
        return int(out)
    # Fallback: pmset prints "No thermal warning level has been recorded" until macOS limits the
    # CPU for heat; a CPU speed limit under 80 % then counts as serious.
    therm = _run(["pmset", "-g", "therm"])
    limits = [int(v) for v in re.findall(r"CPU_Speed_Limit\s*=\s*(\d+)", therm)]
    return 2 if limits and min(limits) < 80 else 0


def read() -> Reading:
    batt = _run(["pmset", "-g", "batt"])
    # A Mac with no battery (a desktop) reports AC power and no percentage.
    on_ac = "AC Power" in batt or "InternalBattery" not in batt
    pct = re.search(r"(\d+)%", batt)
    thermal = thermal_state()
    idle = re.search(r'"HIDIdleTime" = (\d+)', _run(["ioreg", "-c", "IOHIDSystem"]))
    idle_s = int(idle.group(1)) / 1e9 if idle else float("inf")  # nanoseconds
    memory = _run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]).strip()
    return Reading(on_ac, int(pct.group(1)) if pct else None, thermal, idle_s, int(memory) if memory.isdigit() else 1,
                   PAUSE_FILE.exists())


class Guard:
    """Asked by ppo.py between updates. `pids` are the training's processes (main + workers)."""

    def __init__(self, pids: list[int], log_dir: Path, enabled: bool = True, shared: str = "background"):
        self.pids, self.enabled, self.shared = pids, enabled, shared
        if enabled and shared == "nice":
            for pid in pids:  # once and for good: lowering it back would need root
                try:
                    os.setpriority(os.PRIO_PROCESS, pid, 10)
                except OSError:
                    pass
        self.mode, self.reason = "full", ""
        self.checked = 0.0
        self.hot_until = 0.0
        self.paused_s = 0.0
        self.caffeinate: subprocess.Popen | None = None
        new = not (log_dir / "guard.csv").exists()
        self.log = open(log_dir / "guard.csv", "a", newline="")
        self.writer = csv.writer(self.log)
        if new:
            self.writer.writerow(["time", "mode", "reason"])

    def _set_priority(self, background: bool) -> None:
        if self.shared == "nice":
            return  # always nice 10 already
        flag = "-b" if background else "-B"
        for pid in self.pids:
            _run(["taskpolicy", flag, "-p", str(pid)])

    def _awake(self, on: bool) -> None:
        if on and self.caffeinate is None:
            # -i: no idle sleep; -w: ends by itself when this process ends, even if it crashes.
            self.caffeinate = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
        elif not on and self.caffeinate is not None:
            self.caffeinate.terminate()
            self.caffeinate = None

    def _switch(self, mode: str, reason: str) -> None:
        if mode != self.mode:
            self._set_priority(mode != "full")
            self._awake(mode != "paused" or "battery" not in reason)
            print(f"\n[guard] {self.mode} -> {mode}: {reason}", flush=True)
        self.mode, self.reason = mode, reason
        self.writer.writerow([time.strftime("%Y-%m-%d %H:%M:%S"), mode, reason])
        self.log.flush()

    def _decide(self) -> tuple[str, str]:
        reading = read()
        mode, reason = reading.mode()
        now = time.time()
        if reading.thermal >= 2:
            self.hot_until = now + COOL_DOWN_S
        elif mode != "paused" and now < self.hot_until:
            mode, reason = "paused", f"cooling down ({self.hot_until - now:.0f} s more)"
        return mode, reason

    def checkpoint(self) -> None:
        """Called between updates. Returns at once unless the training must wait."""
        if not self.enabled:
            return
        if self.caffeinate is None and self.mode != "paused":
            self._awake(True)
        if time.time() - self.checked < CHECK_EVERY_S:
            return
        self.checked = time.time()
        mode, reason = self._decide()
        if (mode, reason) != (self.mode, self.reason):
            self._switch(mode, reason)
        while self.mode == "paused":
            time.sleep(PAUSED_POLL_S)
            self.paused_s += PAUSED_POLL_S
            mode, reason = self._decide()
            if (mode, reason) != (self.mode, self.reason):
                self._switch(mode, reason)
        self.checked = time.time()

    def close(self) -> None:
        self._awake(False)
        self.log.close()


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m training.guard", description=__doc__.split("\n")[0])
    p.add_argument("command", choices=["status", "pause", "resume"])
    args = p.parse_args()
    if args.command == "pause":
        PAUSE_FILE.touch()
        print("paused: every training waits at its next update (python -m training.guard resume)")
    elif args.command == "resume":
        PAUSE_FILE.unlink(missing_ok=True)
        print("resumed")
    reading = read()
    mode, reason = reading.mode()
    print(f"{mode}: {reason}")
    print(f"  power {'AC' if reading.on_ac else 'battery'} {reading.battery}% · thermal {THERMAL_NAMES[reading.thermal]} · "
          f"idle {reading.idle_s:.0f} s · memory level {reading.memory} · pause file {reading.pause_asked}")
    sys.exit(0)


if __name__ == "__main__":
    main()
