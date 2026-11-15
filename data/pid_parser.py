#!/usr/bin/env python3
"""
Tridi Industrial — Deterministic AutoCAD .dxf P&ID Parser & ISA-5.1 Docs Generator (Task J-6).
Follows the mus3o "AI reasons, code assembles" pattern:
  - Reads an AutoCAD ASCII .dxf P&ID blueprint (e.g., data/pid_samples/01_batch_mixer.dxf)
  - Classifies all ISA-5.1 tags against physics/components/isa_standard.json
  - Verifies 100% source-tag fidelity (verify_pid_sources: 0 hallucinated tags)
  - Outputs the Process DAG JSON and/or full ISA-5.1 Functional Design Specification Markdown.

Usage:
  python3 data/pid_parser.py data/pid_samples/01_batch_mixer.dxf --format md
  python3 data/pid_parser.py data/pid_samples/02_silo_packaging.dxf --format json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
ISA_CATALOG_PATH = ROOT / "physics" / "components" / "isa_standard.json"


def load_isa_standard() -> dict[str, Any]:
    with open(ISA_CATALOG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def classify_isa_tag(tag: str, isa_std: dict[str, Any]) -> dict[str, Any]:
    clean = tag.strip().upper()
    m = re.match(r"^([A-Z]{1,4})-?(\d+[A-Z]?)$", clean)
    prefix = m.group(1) if m else re.sub(r"[^A-Z]", "", clean)
    loop_num = m.group(2) if m else "100"
    catalog = isa_std["tagClasses"].get(
        prefix,
        {
            "prefix": prefix or "EQ",
            "category": "instrument",
            "isaName": f"ISA-5.1 Process Element ({prefix or 'GENERIC'})",
            "ioRequirements": [{"suffix": "PV", "type": "AI", "signal": "4-20 mA", "description": "Process variable"}],
            "failSafe": "Standard fail-safe state",
            "plcBlock": "FB_Analog_Scale",
        },
    )
    return {
        "tag": f"{prefix}-{loop_num}",
        "prefix": prefix,
        "loopNumber": loop_num,
        "category": catalog["category"],
        "isaName": catalog["isaName"],
        "ioRequirements": catalog["ioRequirements"],
        "failSafe": catalog["failSafe"],
        "plcBlock": catalog["plcBlock"],
    }


def parse_dxf_pid(dxf_text: str, file_name: str = "blueprint.dxf") -> dict[str, Any]:
    isa_std = load_isa_standard()
    lines = dxf_text.replace("\r\n", "\n").split("\n")
    project_id = Path(file_name).stem.upper()
    pairs: list[tuple[int, str]] = []
    for i in range(0, len(lines) - 1, 2):
        try:
            pairs.append((int(lines[i].strip()), lines[i + 1].strip()))
        except ValueError:
            continue

    raw_nodes: list[dict[str, Any]] = []
    raw_edges: list[dict[str, str]] = []
    curr: dict[str, Any] | None = None

    for idx, (code, val) in enumerate(pairs):
        if code == 9 and val == "$PROJECT" and idx + 1 < len(pairs) and pairs[idx + 1][0] == 1:
            project_id = pairs[idx + 1][1]
        if code == 0:
            if curr:
                if curr.get("type") == "INSERT" and curr.get("tag"):
                    raw_nodes.append(curr)
                elif curr.get("type") in ("LINE", "LWPOLYLINE") and curr.get("from") and curr.get("to"):
                    raw_edges.append({"from": curr["from"], "to": curr["to"], "layer": curr.get("layer", "PID_PIPING")})
            curr = {"type": val, "x": 0.0, "y": 0.0} if val in ("INSERT", "LINE", "LWPOLYLINE") else None
            continue
        if curr is None:
            continue
        if code == 8:
            curr["layer"] = val
        elif code == 2:
            if curr["type"] == "INSERT":
                curr["block"] = val
            else:
                curr["to"] = val
        elif code == 10:
            curr["x"] = float(val or 0.0)
        elif code == 20:
            curr["y"] = float(val or 0.0)
        elif code == 1:
            if curr["type"] in ("LINE", "LWPOLYLINE"):
                curr["from"] = val
            else:
                curr["tag"] = val
        elif code == 3:
            curr["description"] = val

    nodes = []
    for n in raw_nodes:
        meta = classify_isa_tag(n["tag"], isa_std)
        nodes.append(
            {
                **meta,
                "layer": n.get("layer", "PID_DEFAULT"),
                "block": n.get("block", f"ISA_{meta['prefix']}"),
                "x": n.get("x", 0.0),
                "y": n.get("y", 0.0),
                "description": n.get("description", meta["isaName"]),
            }
        )

    io_schedule = []
    counts = {"DI": 0, "DO": 0, "AI": 0, "AO": 0}
    for node in nodes:
        for req in node["ioRequirements"]:
            io_type = req["type"]
            idx_num = counts[io_type]
            counts[io_type] += 1
            addr = (
                f"%I0.{idx_num}"
                if io_type == "DI"
                else f"%Q0.{idx_num}"
                if io_type == "DO"
                else f"%IW{64 + idx_num * 2}"
                if io_type == "AI"
                else f"%QW{64 + idx_num * 2}"
            )
            io_schedule.append(
                {
                    "plcTag": f"{node['tag'].replace('-', '_')}_{req['suffix']}",
                    "isaTag": node["tag"],
                    "isaFunction": node["isaName"],
                    "ioType": io_type,
                    "address": addr,
                    "signal": req["signal"],
                    "failSafe": node["failSafe"],
                    "plcBlock": node["plcBlock"],
                    "description": f"{node['description']} — {req['description']}",
                }
            )

    unverified = [n["tag"] for n in nodes if n["tag"] not in dxf_text]
    return {
        "fileName": file_name,
        "projectId": project_id,
        "nodes": nodes,
        "edges": raw_edges,
        "ioSchedule": io_schedule,
        "ioSummary": {"totalTags": len(nodes), "totalIoPoints": len(io_schedule), **counts},
        "sourceVerification": {
            "verified": len(unverified) == 0 and len(nodes) > 0,
            "sourceTagCount": len(nodes),
            "verifiedTagCount": len(nodes) - len(unverified),
            "unverifiedTags": unverified,
        },
    }


def render_fds_markdown(dag: dict[str, Any]) -> str:
    lines = [
        f"# FUNCTIONAL DESIGN SPECIFICATION (FDS) — {dag['projectId']}",
        f"- **Blueprint:** `{dag['fileName']}`",
        f"- **Source Verification (`verify_pid_sources`):** {dag['sourceVerification']['verifiedTagCount']}/{dag['sourceVerification']['sourceTagCount']} tags verified",
        f"- **PLC I/O Summary:** {dag['ioSummary']['totalIoPoints']} points ({dag['ioSummary']['DI']} DI, {dag['ioSummary']['DO']} DO, {dag['ioSummary']['AI']} AI, {dag['ioSummary']['AO']} AO)",
        "",
        "## 1. ISA-5.1 Equipment & Instrument Schedule",
        "| ISA Tag | Category | ISA-5.1 Function | Standard PLC Block | Fail-Safe State | Description |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for n in dag["nodes"]:
        lines.append(
            f"| `{n['tag']}` | {n['category']} | {n['isaName']} | `{n['plcBlock']}` | {n['failSafe']} | {n['description']} |"
        )
    lines.extend(
        [
            "",
            "## 2. PLC I/O Schedule (IEC 61131-3)",
            "| Symbolic Tag | ISA Tag | Type | Address | Signal | Block | Description |",
            "| --- | --- | --- | --- | --- | --- | --- |",
        ]
    )
    for io in dag["ioSchedule"]:
        lines.append(
            f"| `{io['plcTag']}` | `{io['isaTag']}` | **{io['ioType']}** | `{io['address']}` | {io['signal']} | `{io['plcBlock']}` | {io['description']} |"
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Parse AutoCAD .dxf P&ID into ISA-5.1 DAG or FDS Markdown.")
    parser.add_argument("dxf_path", type=Path, help="Path to .dxf P&ID file")
    parser.add_argument("--format", choices=("json", "md"), default="md", help="Output format")
    args = parser.parse_args()

    text = args.dxf_path.read_text(encoding="utf-8")
    dag = parse_dxf_pid(text, file_name=args.dxf_path.name)
    if args.format == "json":
        print(json.dumps(dag, indent=2))
    else:
        print(render_fds_markdown(dag))


if __name__ == "__main__":
    main()
