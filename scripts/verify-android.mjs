// Opt-in hardware regression check. It only connects, queries and disconnects;
// it never writes settings or enables the load. Start the debug APK first.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const serial = process.argv[2];
const bluetooth = process.argv.includes("--bluetooth");
const rootUsb = process.argv.includes("--root-usb");
const artifactPrefix = `artifacts/android-${bluetooth ? "ble" : "usb"}${process.argv.includes("--firmware-release") ? "-firmware" : ""}`;
assert(
  serial && !serial.startsWith("--"),
  "Usage: node scripts/verify-android.mjs ADB_SERIAL [--bluetooth] [--seconds=90] [--cycles=3] [--verify-recording]",
);
const seconds = Number(
  process.argv.find((a) => a.startsWith("--seconds="))?.split("=")[1] ?? 90,
);
const cycles = Number(
  process.argv.find((a) => a.startsWith("--cycles="))?.split("=")[1] ?? 3,
);
assert(Number.isInteger(seconds) && seconds >= 5 && seconds <= 3600);
assert(Number.isInteger(cycles) && cycles >= 1 && cycles <= 20);
const adbPath =
  process.env.ADB ??
  resolve(
    process.env.ANDROID_HOME ?? "C:/Android/Sdk",
    "platform-tools",
    process.platform === "win32" ? "adb.exe" : "adb",
  );
const adb = async (...args) =>
  (
    await runFile(adbPath, ["-s", serial, ...args], {
      maxBuffer: 2_000_000,
      timeout: 15000,
    })
  ).stdout.trim();
const pid = await adb("shell", "pidof", "dev.atorch.load");
assert(/^\d+$/.test(pid), "Start Atorch Load on the Android device first");
const port = await adb(
  "forward",
  "tcp:0",
  `localabstract:webview_devtools_remote_${pid}`,
);
const pending = new Map();
let socket;
let id = 0;
try {
  // ADB can report the new process before its debug WebView starts listening.
  let target;
  const discoveryDeadline = Date.now() + 10000;
  while (!target && Date.now() < discoveryDeadline) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json`, {
          signal: AbortSignal.timeout(1500),
        })
      ).json();
      target = targets.find(
        (t) => t.type === "page" && t.title === "Atorch Load",
      );
    } catch {
      // Retry only target discovery; device operations below are not retried.
    }
    if (!target) await new Promise((r) => setTimeout(r, 250));
  }
  assert(target, "No debug WebView found for Atorch Load");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((yes, no) => {
    socket.addEventListener("open", yes, { once: true });
    socket.addEventListener("error", no, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const result = JSON.parse(event.data);
    const task = pending.get(result.id);
    if (!task) return;
    pending.delete(result.id);
    clearTimeout(task.timer);
    result.error
      ? task.reject(new Error(JSON.stringify(result.error)))
      : task.resolve(result.result);
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error(`CDP timed out: ${method}`));
      }, 75000); // Android's USB permission dialog can remain pending for 60s.
      pending.set(request, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: request, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  const invoke = (command, args = {}) =>
    evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
    );
  async function freshSnapshot(minCount = 2) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const s = await invoke("get_snapshot");
      if (s.error) throw new Error(s.error);
      if (
        s.connected &&
        s.telemetry &&
        (bluetooth || s.settings) &&
        s.sampleCount >= minCount
      )
        return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("No fresh telemetry and settings received");
  }
  let diagnostics = await invoke(
    bluetooth ? "get_bluetooth_status" : "get_usb_diagnostics",
  );
  let devices = await invoke(
    bluetooth ? "discover_bluetooth" : "discover_devices",
  );
  let before = await invoke("get_snapshot");
  assert(
    !before.recording,
    "A recording is active; leave the user's session intact",
  );
  async function ensureUsb() {
    let found = await invoke("discover_devices");
    if (!found.length && rootUsb) {
      if ((await invoke("get_snapshot")).connected)
        await invoke("disconnect_device");
      console.log("Explicit --root-usb: enabling the app's USB Host session");
      await invoke("set_root_usb_host", { enabled: true });
      const end = Date.now() + 10000;
      while (!found.length && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 200));
        found = await invoke("discover_devices");
      }
    }
    return found;
  }
  if (!bluetooth && !devices.length && rootUsb) {
    devices = await ensureUsb();
    diagnostics = await invoke("get_usb_diagnostics");
    before = await invoke("get_snapshot");
  }
  if (bluetooth) diagnostics = await invoke("get_bluetooth_status");
  assert(
    devices.length,
    bluetooth
      ? "No BW150_BLE found; disconnect other BLE apps, check power and Bluetooth"
      : "Android has not enumerated a supported BW150; check OTG and its data cable",
  );
  console.log(JSON.stringify({ devices, diagnostics }, null, 2));
  assert(
    !before.recording,
    "A recording is active; leave the user's session intact",
  );
  const reports = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    if (
      cycle ||
      !before.connected ||
      (before.device?.transport === "bluetooth") !== bluetooth
    ) {
      if (cycle || before.connected) await invoke("disconnect_device");
      if (!bluetooth && rootUsb) {
        devices = await ensureUsb();
        assert(
          devices.length,
          "USB device did not re-enumerate after reconnect",
        );
      }
      await invoke("connect_device", { path: devices[0].path });
    }
    const first = await freshSnapshot();
    const deadline = Date.now() + (seconds * 1000) / cycles;
    let last = first;
    let checks = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      last = await freshSnapshot(first.sampleCount + checks + 1);
      assert.equal(last.device.serial, first.device.serial);
      if (bluetooth) {
        assert.equal(last.device.transport, "bluetooth");
        assert.equal(last.settings, null);
        assert.equal(last.telemetry.energy, null);
        assert.equal(last.telemetry.resistance, null);
        assert.equal(last.telemetry.running, null);
        assert.equal(typeof last.telemetry.mosTemperature, "number");
        assert.equal(last.telemetry.deviceTemperature, undefined);
      }
      assert(Date.now() - last.lastReportAt < 5000, "Stale Android telemetry");
      for (const [key, value] of Object.entries(last.telemetry)) {
        if (typeof value === "number")
          assert(Number.isFinite(value), `Invalid telemetry: ${key}`);
      }
      checks++;
    }
    reports.push({
      cycle: cycle + 1,
      firstCount: first.sampleCount,
      lastCount: last.sampleCount,
      snapshot: last,
    });
    console.log(
      `Cycle ${cycle + 1}: ${last.sampleCount - first.sampleCount} new samples; ${bluetooth ? "BLE" : "USB"} stable`,
    );
  }
  assert.equal(
    await adb("shell", "pidof", "dev.atorch.load"),
    pid,
    "App process restarted during the check",
  );
  const crashLog = await adb(
    "logcat",
    "-d",
    "-b",
    "crash",
    `--pid=${pid}`,
    "-v",
    "brief",
  );
  assert(
    !/Fatal signal|FATAL EXCEPTION/.test(crashLog),
    "Android process crashed",
  );
  await mkdir("artifacts", { recursive: true });
  let recording;
  if (process.argv.includes("--verify-recording")) {
    try {
      await invoke("set_recording", { enabled: true });
      recording = (await invoke("get_snapshot")).recording;
      const start = (await invoke("get_snapshot")).sampleCount;
      await freshSnapshot(start + 3);
    } finally {
      await invoke("set_recording", { enabled: false });
    }
    assert(
      recording &&
        /^\/data\/(?:user\/0|data)\/dev\.atorch\.load\/[a-zA-Z0-9_./-]+\.csv$/.test(
          recording,
        ),
    );
    const csv = await adb(
      "exec-out",
      "run-as",
      "dev.atorch.load",
      "cat",
      recording,
    );
    const lines = csv
      .replace(/^\uFEFF/, "")
      .trim()
      .split(/\r?\n/);
    assert(lines.length >= 4, "Expected at least 3 recorded samples");
    if (bluetooth)
      for (const line of lines.slice(1)) {
        const fields = line.split(",");
        for (const index of [4, 5, 7, 8, 9, 10])
          assert.equal(
            fields[index],
            "",
            `Unavailable BLE field ${index} must stay blank`,
          );
        assert(Number.isFinite(Number(fields[11])) && fields[11] !== "");
      }
    await writeFile(`${artifactPrefix}-recording.csv`, csv);
    console.log(`Recording verified: ${lines.length - 1} rows`);
  }
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(
    `${artifactPrefix}-connected.png`,
    Buffer.from(screenshot.data, "base64"),
  );
  const report = {
    timestamp: new Date().toISOString(),
    serial,
    pid,
    seconds,
    cycles,
    bluetooth,
    rootUsb,
    recording,
    diagnostics,
    reports,
    crashLog,
  };
  await writeFile(
    `${artifactPrefix}-verification.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(
    `Verified ${cycles} connection cycles over ${seconds}s; no new crash. Device remains connected.`,
  );
} finally {
  socket?.close();
  for (const task of pending.values()) clearTimeout(task.timer);
  await adb("forward", "--remove", `tcp:${port}`);
}
