"""Read-only BW150 USB rate sweep. Sends only the recovered 03/05 queries."""
import argparse
from collections import deque
import json
import math
from pathlib import Path
import statistics
import time

import hid


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--rates", type=int, nargs="+", default=[2, 5, 10])
    parser.add_argument("--output", default="artifacts/usb-rates/raw-sweep.json")
    args = parser.parse_args()
    if not 5 <= args.seconds <= 120 or any(rate not in [2, 5, 10] for rate in args.rates):
        parser.error("seconds must be 5..120; rates must be 2, 5 or 10")
    devices = hid.enumerate(0x0483, 0x5750)
    if len(devices) != 1 or "BW150" not in devices[0].get("product_string", ""):
        raise RuntimeError("Exactly one APP-mode BW150 is required")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    device = hid.device()
    device.open_path(devices[0]["path"])
    report = {
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "device": {key: devices[0].get(key) for key in ["product_string", "serial_number"]},
        "readOnly": True,
        "allowedQueries": [3, 5],
        "runs": [],
    }
    writes = []

    def query(kind):
        assert kind in [3, 5]
        packet = bytes([0, 0x55, 5, 1, kind, 0x0b, 0, 0x8c, 0xee, 0xff]) + bytes(55)
        sent = time.perf_counter()
        count = device.write(packet)
        if count != 65:
            raise RuntimeError(f"Short USB query write: {count}/65")
        writes.append({"time": sent, "kind": kind})
        return sent

    def read(timeout_ms):
        data = bytes(device.read(64, max(1, int(timeout_ms))))
        if data and (len(data) != 64 or data[:3] != bytes([0xaa, 5, 1]) or data[-2:] != bytes([0xee, 0xff])):
            raise RuntimeError(f"Invalid USB reply: {data.hex()}")
        return data

    def settings():
        query(3)
        deadline = time.perf_counter() + 2
        while time.perf_counter() < deadline:
            data = read(100)
            if data and data[3] == 3:
                return data
        raise RuntimeError("No settings reply within 2 seconds")

    try:
        # Drain only stale input, then take an immutable parameter baseline.
        while device.read(64, 5):
            pass
        initial = settings()
        report["settingsBefore"] = initial.hex()
        for rate in args.rates:
            while device.read(64, 5):
                pass
            start = time.perf_counter()
            deadline = start + args.seconds
            next_data, next_settings = start, start + 0.05
            pending = deque()
            samples, latencies, parameter_replies = [], [], []
            skipped = 0
            while time.perf_counter() < deadline:
                now = time.perf_counter()
                if now >= next_data:
                    if pending:
                        skipped += 1
                    else:
                        pending.append(query(5))
                    next_data += 1 / rate
                    if next_data <= now:
                        next_data = now + 1 / rate
                if now >= next_settings:
                    query(3)
                    next_settings += 1
                wait = min(next_data, next_settings, deadline) - time.perf_counter()
                data = read(min(20, max(1, wait * 1000)))
                received = time.perf_counter()
                if not data:
                    if pending and received - pending[0] > 2:
                        raise RuntimeError(f"{rate} Hz: telemetry timeout")
                    continue
                if data[3] == 3:
                    parameter_replies.append(data.hex())
                    if data != initial:
                        raise RuntimeError("Device parameters changed during the read-only sweep")
                elif data[3] == 5:
                    sent = pending.popleft() if pending else None
                    latency = (received - sent) * 1000 if sent is not None else None
                    if latency is not None:
                        latencies.append(latency)
                    values = [int.from_bytes(data[offset:offset + 4], "little") / 1000 for offset in [8, 12, 16]]
                    samples.append({"elapsedMs": (received - start) * 1000, "latencyMs": latency,
                                    "voltage": values[0], "current": values[1], "power": values[2],
                                    "running": data[52] != 0, "raw": data.hex()})
            gaps = [b["elapsedMs"] - a["elapsedMs"] for a, b in zip(samples, samples[1:])]
            actual_hz = 1000 / statistics.mean(gaps) if gaps else 0
            changes = {}
            for key in ["voltage", "current", "power"]:
                times = [b["elapsedMs"] for a, b in zip(samples, samples[1:]) if a[key] != b[key]]
                change_gaps = [b - a for a, b in zip(times, times[1:])]
                changes[key] = {"transitions": len(times), "medianChangeGapMs": statistics.median(change_gaps) if change_gaps else None}
            result = {"requestedHz": rate, "seconds": args.seconds, "samples": len(samples),
                      "actualHz": actual_hz, "meanGapMs": statistics.mean(gaps) if gaps else None,
                      "p95GapMs": percentile(gaps, .95), "maxGapMs": max(gaps) if gaps else None,
                      "p95LatencyMs": percentile(latencies, .95), "maxLatencyMs": max(latencies) if latencies else None,
                      "skippedQueries": skipped, "parameterReplies": len(parameter_replies),
                      "parametersUnchanged": True, "numericChanges": changes, "rows": samples}
            report["runs"].append(result)
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({key: value for key, value in result.items() if key != "rows"}, ensure_ascii=False), flush=True)
        final = settings()
        report["settingsAfter"] = final.hex()
        report["parametersUnchanged"] = initial == final
        report["writes"] = writes
        report["completed"] = True
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        device.close()
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
