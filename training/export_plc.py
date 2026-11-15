#!/usr/bin/env python3
"""
Tridi Industrial — Modular PLC Flat-File Exporter (Task J-6 / Priority 3).
Generates standardized "Lego" Function Blocks (`FB_Motor_Standard`, `FB_Valve_Standard`, `FB_Batch_Sequencer`)
from an AutoCAD .dxf P&ID blueprint in:
  - Siemens TIA Portal Structured Control Language (.scl — IEC 61131-3)
  - Rockwell Studio 5000 Logix Designer ASCII Flat File (.L5K)

Usage:
  python3 training/export_plc.py data/pid_samples/01_batch_mixer.dxf --target scl
  python3 training/export_plc.py data/pid_samples/02_silo_packaging.dxf --target l5k
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "data"))
from pid_parser import parse_dxf_pid  # noqa: E402


def export_scl(dag: dict) -> str:
    valves = [n for n in dag["nodes"] if n["prefix"] in ("FV", "PK")]
    motors = [n for n in dag["nodes"] if n["prefix"] in ("M", "P", "SC", "CV")]
    high_sw = [n for n in dag["nodes"] if n["prefix"] == "LSH"]
    main_high = f"{high_sw[0]['tag'].replace('-', '_')}_ALM" if high_sw else "LSH_101_ALM"

    lines = [
        "// ============================================================================",
        f"// TRIDI INDUSTRIAL — SIEMENS TIA PORTAL (.SCL) — {dag['projectId']}",
        f"// Source Blueprint: {dag['fileName']} | Tags: {len(dag['nodes'])} | I/O: {dag['ioSummary']['totalIoPoints']}",
        "// ============================================================================",
        "",
        'FUNCTION_BLOCK "FB_Motor_Standard"',
        "VERSION : 0.1",
        "   VAR_INPUT",
        "      StartCmd, StopCmd, RunStatus, ThermalOverloadOk, InterlockHealthy, ResetFault : Bool;",
        "      ScanDelta_s : Real := 0.02;",
        "   END_VAR",
        "   VAR_OUTPUT",
        "      ContactorOut, FaultActive : Bool;",
        "      RunHours : Real;",
        "   END_VAR",
        "   VAR",
        "      OperatingSeconds : Real := 0.0;",
        "   END_VAR",
        "BEGIN",
        "   IF NOT #ThermalOverloadOk THEN #FaultActive := TRUE;",
        "   ELSIF #ResetFault AND #ThermalOverloadOk THEN #FaultActive := FALSE; END_IF;",
        "   #ContactorOut := #StartCmd AND NOT #StopCmd AND NOT #FaultActive AND #InterlockHealthy;",
        "   IF #RunStatus THEN #OperatingSeconds := #OperatingSeconds + #ScanDelta_s; #RunHours := #OperatingSeconds / 3600.0; END_IF;",
        "END_FUNCTION_BLOCK",
        "",
        'ORGANIZATION_BLOCK "OB1_ISA88_Batch_Sequencer"',
        "BEGIN",
        f'   // Cause & Effect Interlock: {main_high} (NC Fail-Safe)',
    ]
    for v in valves:
        base = v["tag"].replace("-", "_")
        lines.append(f'   "Inst_{base}"(OpenCmd := "BatchDB".StepCmd_{base}, InterlockHealthy := "{main_high}");')
    for m in motors:
        base = m["tag"].replace("-", "_")
        lines.append(f'   "Inst_{base}"(StartCmd := "BatchDB".StepCmd_{base}, InterlockHealthy := "{main_high}");')
    lines.append("END_ORGANIZATION_BLOCK")
    return "\n".join(lines) + "\n"


def export_l5k(dag: dict) -> str:
    lines = [
        f"(* TRIDI INDUSTRIAL — ROCKWELL STUDIO 5000 (.L5K) — {dag['projectId']} *)",
        "IE_VER := 2.24;",
        f"CONTROLLER {dag['projectId']} (ProcessorType := \"1756-L83E\", Major := 35)",
        "  TAG",
    ]
    for io in dag["ioSchedule"]:
        dtype = "REAL" if io["ioType"] in ("AI", "AO") else "BOOL"
        lines.append(f"    {io['plcTag']} : {dtype} (Description := \"{io['isaTag']} [{io['address']}]\");")
    lines.extend(["  END_TAG", "END_CONTROLLER"])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Export modular PLC code (.scl / .L5K) from .dxf P&ID.")
    parser.add_argument("dxf_path", type=Path, help="Path to .dxf P&ID file")
    parser.add_argument("--target", choices=("scl", "l5k"), default="scl", help="Target PLC dialect")
    args = parser.parse_args()

    dag = parse_dxf_pid(args.dxf_path.read_text(encoding="utf-8"), file_name=args.dxf_path.name)
    print(export_scl(dag) if args.target == "scl" else export_l5k(dag))


if __name__ == "__main__":
    main()
