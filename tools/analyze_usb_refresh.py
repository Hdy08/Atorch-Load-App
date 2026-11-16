"""Offline audit of the pinned BW150 V1.1.0 USB telemetry refresh path.

Reads the vendor image, extracted APP, local ISA and existing captures only.
Never imports HID, opens a device, generates firmware or changes application
sampling. With --output, creates a new JSON report without overwriting files.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
import statistics
import struct
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BASE = 0x1E00120
APP_SHA = "afe464c4f358787bcaca409223e9c327926845b89e1f2d6dc3ada3181dab87cf"
SOURCE_SHA = "009e6b5c344c26e8d4949293248241fa65d9d053f4577ef17e38569fe8ae99ad"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def instructions(context, app, start, end):
    result = []
    address = start
    while address < end:
        item = context.disassemble(
            app[address - BASE:address - BASE + 16], address,
            max_instructions=1,
        ).instructions[0]
        require(item.length > 0 and address + item.length <= end,
                f"Invalid instruction boundary at {address:#x}")
        result.append({
            "address": hex(address),
            "bytes": app[address - BASE:address - BASE + item.length].hex(),
            "mnemonic": item.mnem,
            "operands": item.body,
        })
        address += item.length
    return result


def firmware_evidence(app, context):
    require(digest(app) == APP_SHA, "Extracted APP is not the pinned vendor image")
    table = 0x1E01506
    dispatch = [{
        "command": f"{command:02X}",
        "target": hex(table + 2 * struct.unpack_from(
            "<H", app, table - BASE + 2 * (command - 3),
        )[0]),
    } for command in range(3, 0x52)]
    require(dispatch[0]["target"] == "0x1e015a4", "03 dispatch changed")
    require(dispatch[2]["target"] == "0x1e01736", "05 dispatch changed")
    require(all(row["target"] == "0x1e02000" for row in dispatch[3:29]),
            "06..1F no longer all use the default return")

    spans = {
        "dispatch_header": (0x1E014B6, 0x1E01506),
        "telemetry": (0x1E01736, 0x1E01A3C),
        "sensor_read_helper": (0x1E06782, 0x1E06818),
        "measurement_loop_setup": (0x1E06ADE, 0x1E06B0C),
        # The local ISA does not decode the conditional at 06B0C. Keep that
        # gap explicit instead of inventing a constructor or control flow.
        "measurement_read_paths": (0x1E06B10, 0x1E06E88),
    }
    listings = {name: instructions(context, app, *span)
                for name, span in spans.items()}
    by_address = {int(row["address"], 16): row
                  for listing in listings.values() for row in listing}
    expected = {
        0x1E014F2: "e1e48585",  # Bounded command table.
        0x1E01504: "b200",      # Halfword table branch.
        0x1E01770: "f5fcb801",  # Cache base: 3FE0 + 1B8.
        0x1E01774: "304a",      # Voltage: cache + 0C = 41A4.
        0x1E017B4: "08f61850",  # Current: cache + 18 = 41B0.
        0x1E017F4: "904a",      # Power: cache + 24 = 41BC.
        0x1E067CE: "4070",      # Read helper: delay argument 4.
        0x1E067D0: "98f3f202",  # Call the original OS delay.
        0x1E06AFE: "1070",      # Measurement loop: delay argument 1.
        0x1E06B00: "98f35a01",  # Call the original OS delay.
    }
    for address, raw in expected.items():
        require(by_address[address]["bytes"] == raw,
                f"Pinned instruction changed at {address:#x}")
    reads = [row for row in listings["measurement_read_paths"]
             if row["mnemonic"] == "call" and row["operands"] == "0x1e06782"]
    require([row["address"] for row in reads] == [
        "0x1e06b2c", "0x1e06b36", "0x1e06bce", "0x1e06db0",
    ], "Measurement read call sites changed")
    telemetry_calls = sorted({row["operands"] for row in listings["telemetry"]
                              if row["mnemonic"] == "call"})
    require("0x1e06782" not in telemetry_calls,
            "05 now directly calls the measurement read helper")
    return {
        "scope": "Pinned BW150 V1.1.0 APP USB callback and selected measurement paths only",
        "dispatch": dispatch,
        "cache_sources": {"voltage": "0x41a4", "current": "0x41b0", "power": "0x41bc"},
        "sequential_sensor_read_calls": reads,
        "sensor_read_delay_argument_os_ticks": 4,
        "measurement_loop_delay_argument_os_ticks": 1,
        "os_tick_duration_assumed": False,
        "telemetry_direct_call_targets": telemetry_calls,
        "listings": listings,
        "limits": [
            "Static audit, not a hardware timing or ADC bandwidth measurement.",
            "The local ISA cannot decode 01E06B0C..01E06B10; that conditional is excluded, not modeled.",
            "No faster measurement query was identified in this USB callback; other transports are not ruled out.",
            "Equal values do not distinguish a new stable or quantized sample from a cached sample.",
            "No host repair establishing ten independently refreshed measurement sets per second was found.",
        ],
    }


def csv_evidence(path):
    raw = path.read_bytes()
    rows = list(csv.DictReader(raw.decode("utf-8-sig").splitlines()))
    require(len(rows) >= 2, "CSV requires at least two samples")
    gaps = [int(b["ELAPSED_MS"]) - int(a["ELAPSED_MS"])
            for a, b in zip(rows, rows[1:])]
    require(all(gap > 0 for gap in gaps), "This diagnostic expects increasing elapsed time")
    measurements = [key for key in rows[0] if key not in {"DATE", "ELAPSED_MS", "SEGMENT_ID"}]
    equal = lambda fields: sum(all(a[key] == b[key] for key in fields)
                              for a, b in zip(rows, rows[1:]))
    return {
        "path": str(path.resolve()), "sha256": digest(raw), "rows": len(rows),
        "adjacent_pairs": len(gaps), "observed_record_hz": 1000 / statistics.mean(gaps),
        "interval_ms": {"minimum": min(gaps), "median": statistics.median(gaps), "maximum": max(gaps)},
        "equal_adjacent_values": {key: equal([key])
                                  for key in ["VOLTAGE(V)", "CURRENT(A)", "POWER(W)"]},
        "all_measurements_equal_adjacent_pairs": equal(measurements),
    }


def raw_evidence(path):
    raw = path.read_bytes()
    capture = json.loads(raw)
    runs = []
    for run in capture["runs"]:
        frames = [bytes.fromhex(row["raw"]) for row in run["rows"]]
        require(all(len(frame) == 64 and frame[:4] == b"\xaa\x05\x01\x05"
                    and frame[62:] == b"\xee\xff" for frame in frames),
                "Invalid captured telemetry frame")
        runs.append({
            "requested_hz": run["requestedHz"], "frames": len(frames),
            "observed_reply_hz": run["actualHz"],
            "equal_adjacent_raw_fields": {
                key: sum(a[offset:offset + 4] == b[offset:offset + 4]
                         for a, b in zip(frames, frames[1:]))
                for key, offset in [("voltage", 8), ("current_magnitude", 12), ("power", 16)]
            },
            "whole_frame_equal_adjacent_pairs": sum(a == b for a, b in zip(frames, frames[1:])),
            "numeric_changes": run["numericChanges"],
        })
    return {"path": str(path.resolve()), "sha256": digest(raw),
            "capture_started_at": capture["startedAt"], "runs": runs,
            "same_capture_as_user_csv": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    source = ROOT / "Firmware&Software/BW150-6321-APP-1-1-0-UPP.bin"
    require(digest(source.read_bytes()) == SOURCE_SHA, "Vendor source image changed")
    app_path = ROOT / "artifacts/vendor-bw150-firmware/files/app.bin"
    app = app_path.read_bytes()
    sys.path.insert(0, str(ROOT / ".local/q32-python"))
    import pypcode
    isa = ROOT / ".local/ghidra-jieli/data/languages"
    language = ET.parse(isa / "JieLi.ldefs").find("language[@id='q32s:LE:32:default']")
    require(language is not None, "Local q32s ISA is unavailable")
    context = pypcode.Context(pypcode.ArchLanguage(str(isa), language))
    report = {
        "status": "no_host_only_independent_10hz_fix_identified",
        "device_access": False, "firmware_modified": False,
        "application_source_modified": False,
        "source_sha256": SOURCE_SHA, "app_sha256": digest(app),
        "isa_sha256": digest((isa / "q32s.sla").read_bytes()),
        "firmware": firmware_evidence(app, context),
        "previous_raw_capture": raw_evidence(ROOT / "artifacts/usb-rates/raw-sweep.json"),
    }
    if args.csv:
        report["user_csv"] = csv_evidence(args.csv)
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        with args.output.open("x", encoding="utf-8") as handle:
            handle.write(text)
        print(json.dumps({"status": report["status"], "output": str(args.output)}, ensure_ascii=False))
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
