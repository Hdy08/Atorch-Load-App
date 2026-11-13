// Hardware QA. Default: scan/connect/read only. --controls performs panel key
// writes at zero input, with USB reference readback; no clear/reset/flash probes.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { debugApp, until, sleep } from "./lib/native-debug.mjs";

const option = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const serial = option("android");
const referenceSerial = option("usb-reference-android");
const controls = process.argv.includes("--controls");
const rootUsb = process.argv.includes("--root-usb");
const resume = option("resume-controls");
const background = Number(option("background-seconds") || 0);
const cycles = Number(option("cycles") || 1);
const seconds = Number(option("seconds") || 0);
const recordSeconds = Number(option("record-seconds") || 0);
assert(Number.isInteger(background) && background >= 0 && background <= 600);
assert(Number.isInteger(cycles) && cycles >= 1 && cycles <= 10);
assert(Number.isInteger(seconds) && seconds >= 0 && seconds <= 120);
assert(
  Number.isInteger(recordSeconds) && recordSeconds >= 0 && recordSeconds <= 120,
);
assert(!(background && recordSeconds));
assert(!background || serial, "Background QA requires Android");
assert(
  !controls || serial || referenceSerial,
  "Panel QA requires an Android USB reference",
);
const prefix =
  option("output") ||
  `artifacts/${serial ? "android" : "windows"}-ble-controls`;
const app = await debugApp(serial);
const reference = referenceSerial ? await debugApp(referenceSerial) : app;
const report = resume
  ? JSON.parse(await readFile(resume, "utf8"))
  : {
      time: new Date().toISOString(),
      serial,
      pid: app.pid,
      controls,
      checks: [],
    };
if (resume) {
  assert(controls && report.pid === app.pid && report.checks.length === 4);
  report.scriptInterruption = report.error;
  delete report.error;
  report.resumedAt = new Date().toISOString();
}
let baseline = resume ? report.before : undefined;
let bleInfo;
let rootEnabledByQa = false;
let referenceBarrier = 0;
const snapshot = () => app.invoke("get_snapshot");

async function usb(requireStopped = true) {
  const before = await reference.invoke("get_snapshot");
  assert(
    !before.recording && !before.firmware?.active,
    "Preserve ongoing recording/upgrade",
  );
  if (!(before.connected && before.device?.transport === "usb")) {
    if (before.connected) await reference.invoke("disconnect_device");
    let devices = await reference.invoke("discover_devices");
    if (!devices.length && rootUsb) {
      const state = await reference.invoke("get_usb_diagnostics");
      if (!state?.rootUsb?.enabled) {
        await reference.invoke("set_root_usb_host", { enabled: true });
        rootEnabledByQa = true;
      }
      devices = await until(async () => {
        const ds = await reference.invoke("discover_devices");
        return ds.length && ds;
      });
    }
    const info = devices.find((d) => d.name === "ATORCH BW150 V1.1.0");
    assert(info, "USB reference must be the verified BW150 application");
    await reference.invoke("connect_device", { path: info.path });
  }
  return until(async () => {
    const s = await reference.invoke("get_snapshot");
    return (
      s.connected &&
      s.settings &&
      (!requireStopped || s.telemetry?.running === false) &&
      s.telemetry?.voltage === 0 &&
      s.sampleCount >= 2 &&
      s
    );
  });
}

async function ble() {
  const before = await snapshot();
  assert(
    !before.recording && !before.firmware?.active,
    "Preserve ongoing recording/upgrade",
  );
  if (before.connected && before.device?.transport === "bluetooth") {
    bleInfo = before.device;
    return before;
  }
  if (before.connected) await app.invoke("disconnect_device");
  if (!bleInfo) {
    const devices = await app.invoke("discover_bluetooth");
    bleInfo = devices.find((d) => d.name.toUpperCase().startsWith("BW150"));
    assert(bleInfo, "BW150_BLE not found");
  }
  await app.invoke("connect_device", { path: bleInfo.path });
  return until(async () => {
    const s = await snapshot();
    return (
      s.connected &&
      s.device?.transport === "bluetooth" &&
      s.sampleCount >= 2 &&
      s
    );
  });
}

async function panel(action, label) {
  await ble();
  await app.click("实时监控");
  await until(() => app.evaluate("!!document.querySelector('.ble-controls')"));
  const before = (await snapshot()).logs.length;
  await app.click(label);
  if (action === "keyOk") {
    await until(() =>
      app.evaluate(
        "[...document.querySelectorAll('[role=dialog]')].some(d=>d.textContent.includes('发送确认键'))",
      ),
    );
    await app.click("发送一次 OK");
  }
  await until(async () => {
    const s = await snapshot();
    const log = s.logs
      .slice(before)
      .find((l) => l.message.includes("蓝牙") && l.message.includes("已发送"));
    if (s.error) throw Error(s.error);
    return log;
  });
  const result = await app.evaluate(
    "document.querySelector('.ble-controls').textContent",
  );
  assert(result.includes("未提供执行确认"));
  if (app !== reference) {
    referenceBarrier = (await reference.invoke("get_snapshot")).sampleCount + 2;
  }
  report.checks.push({
    action,
    transportCompleted: true,
    deviceConfirmed: false,
  });
  console.log(`${action}: transport completed; inspecting USB`);
}

async function readTarget(target, requireStopped = true) {
  if (app === reference) await app.invoke("disconnect_device");
  await usb(requireStopped);
  return until(async () => {
    const s = await reference.invoke("get_snapshot");
    if (app !== reference && s.sampleCount < referenceBarrier) return false;
    if (requireStopped) assert.equal(s.telemetry?.running, false);
    assert.equal(s.telemetry?.voltage, 0);
    return (
      s.settings?.mode === 0 &&
      (typeof target === "function"
        ? target(s.settings.target)
        : Math.abs(s.settings.target - target) < 0.00001) &&
      s
    );
  });
}

try {
  if (!resume) report.initial = await snapshot();
  assert(!report.initial.recording && !report.initial.firmware?.active);
  if (controls && !resume) {
    baseline = await usb();
    assert.equal(
      baseline.settings.mode,
      0,
      "Use CC with zero input for reversible key QA",
    );
    assert.equal(baseline.telemetry.running, false);
    assert.equal(baseline.telemetry.voltage, 0);
    assert(baseline.settings.target >= 0.1 && baseline.settings.target <= 2);
    report.before = baseline;
    if (app === reference) await app.invoke("disconnect_device");
    await panel("keyPlus", "加 +");
    // The selected physical digit controls the step. BLE cannot read that
    // context: check the actual change, never assume a fixed 0.1 A step.
    report.afterPlus = await readTarget((t) => t > baseline.settings.target);
    report.keyStep =
      report.afterPlus.settings.target - baseline.settings.target;
    if (app === reference) await app.invoke("disconnect_device");
    await panel("keyMinus", "减 −");
    report.afterMinus = await readTarget(baseline.settings.target);
    if (app === reference) await app.invoke("disconnect_device");
    await panel("keySet", "设置 SET");
    await sleep(600);
    await panel("keyOk", "确认 OK…");
  }
  if (controls) {
    report.afterOk = await readTarget(baseline.settings.target, false);
    // OK may toggle RUN even at zero input. Restore STOP through USB readback.
    await reference.invoke("send_command", {
      command: { kind: "running", value: 0 },
    });
    referenceBarrier = (await reference.invoke("get_snapshot")).sampleCount + 2;
    report.afterKeys = await readTarget(baseline.settings.target);
    assert.deepEqual(
      report.afterKeys.settings,
      baseline.settings,
      "Panel QA must preserve the original settings",
    );
    report.settingsRestored = true;
    if (app === reference) await app.invoke("disconnect_device");
  }
  report.connected = await ble();
  assert.equal(report.connected.settings, null);
  assert.equal(report.connected.telemetry.running, null);
  assert.equal(report.connected.error, null);
  report.cycles = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    if (cycle) {
      await app.invoke("disconnect_device");
      await ble();
    }
    const before = await snapshot();
    for (let i = 0; i < seconds; i++) await sleep(1000);
    const after = await snapshot();
    assert(after.connected && !after.error);
    assert(Date.now() - after.telemetry.timestamp < 2500);
    assert(after.sampleCount - before.sampleCount >= seconds * 0.7);
    assert.equal(after.settings, null);
    assert.equal(after.telemetry.running, null);
    report.cycles.push({
      cycle: cycle + 1,
      seconds,
      samples: after.sampleCount - before.sampleCount,
    });
    console.log(
      `BLE connection ${cycle + 1}/${cycles}: ${after.sampleCount - before.sampleCount} new samples`,
    );
  }
  await app.click("实时监控");
  if (background || recordSeconds) {
    const duration = background || recordSeconds;
    if (background) {
      const services = await app.adb(
        "shell",
        "dumpsys",
        "activity",
        "services",
        "dev.atorch.ble.BleConnectionService",
      );
      assert(
        services.includes("isForeground=true"),
        "BLE foreground service was not started",
      );
      await writeFile(`${prefix}-service.txt`, services);
    }
    await app.invoke("set_recording", { enabled: true });
    const before = await snapshot();
    if (background) await app.adb("shell", "input", "keyevent", "KEYCODE_HOME");
    for (let i = 0; i < duration; i++) {
      await sleep(1000);
      if (i % 15 === 14) console.log(`Recording: ${i + 1}/${duration}s`);
    }
    if (background) {
      await app.adb(
        "shell",
        "am",
        "start",
        "-n",
        "dev.atorch.load/.MainActivity",
      );
    }
    const after = await snapshot();
    assert(after.connected && !after.error);
    if (serial)
      assert.equal(
        (await app.adb("shell", "pidof", "dev.atorch.load")).trim(),
        app.pid,
      );
    assert(
      after.sampleCount - before.sampleCount >= duration * 0.7,
      "Insufficient native background samples",
    );
    assert.equal(after.recording, before.recording);
    await app.invoke("set_recording", { enabled: false });
    const csv = serial
      ? await app.adb(
          "shell",
          "run-as",
          "dev.atorch.load",
          "cat",
          before.recording,
        )
      : await readFile(before.recording, "utf8");
    const rows = csv.trim().split(/\r?\n/).slice(1);
    assert(rows.length >= duration * 0.7);
    await writeFile(
      `${prefix}-${background ? "background" : "recording"}.csv`,
      csv,
    );
    report[background ? "background" : "recording"] = {
      seconds: duration,
      samples: after.sampleCount - before.sampleCount,
      csvRows: rows.length,
      pidUnchanged: true,
    };
  }
  await app.screenshot(`${prefix}.png`);
  report.final = await snapshot();
  report.completed = true;
} catch (error) {
  report.error = String(error);
  // Do not send blind compensating BLE keys. Restore via the verified USB
  // target command only after stopped/zero-input USB readback is available.
  if (baseline) {
    try {
      const current = await usb(false);
      if (current.telemetry.voltage === 0 && current.telemetry.running) {
        await reference.invoke("send_command", {
          command: { kind: "running", value: 0 },
        });
        current.telemetry.running = false;
      }
      if (
        current.telemetry.running === false &&
        current.telemetry.voltage === 0 &&
        current.settings.mode === 0 &&
        current.settings.target !== baseline.settings.target
      ) {
        await reference.invoke("send_command", {
          command: {
            kind: "target",
            value: baseline.settings.target,
            expectedMode: 0,
          },
        });
        report.restoredAfterError = await reference.invoke("get_snapshot");
      }
    } catch (cleanup) {
      report.cleanupError = String(cleanup);
    }
  }
  throw error;
} finally {
  if (rootEnabledByQa && app !== reference) {
    await reference.invoke("disconnect_device").catch(() => {});
    await reference
      .invoke("set_root_usb_host", { enabled: false })
      .catch(() => {});
  }
  await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2));
  if (reference !== app) await reference.close();
  await app.close();
  console.log(
    JSON.stringify({
      completed: report.completed,
      error: report.error,
      checks: report.checks,
      background: report.background,
      recording: report.recording,
      settingsRestored: report.settingsRestored,
    }),
  );
}
