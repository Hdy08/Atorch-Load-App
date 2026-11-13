// Opt-in Windows / Android hardware acceptance. Default is read-only inspection.
// --check-official verifies that a running vendor application blocks upgrades.
// --flash explicitly performs the single pinned BW150 update through its UI.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const serial = process.argv.find((a) => a.startsWith("--android="))?.slice(10);
const adb = async (...args) =>
  (
    await run(
      "C:/Android/Sdk/platform-tools/adb.exe",
      ["-s", serial, ...args],
      { timeout: 20000, maxBuffer: 16000000 },
    )
  ).stdout;
const pid = serial
  ? (await adb("shell", "pidof", "dev.atorch.load")).trim()
  : null;
const port = serial
  ? (
      await adb(
        "forward",
        "tcp:0",
        `localabstract:webview_devtools_remote_${pid}`,
      )
    ).trim()
  : "9223";
const recovery = process.argv.includes("--recover");
const prepareUsb = process.argv.includes("--prepare-usb");
const baselineFile = process.argv
  .find((a) => a.startsWith("--restore-baseline="))
  ?.slice(19);
assert(
  !recovery || (serial && baselineFile),
  "Android recovery requires the saved pre-upgrade baseline",
);
const prefix = `artifacts/${serial ? "android" : "windows"}-firmware${recovery ? "-recovery" : ""}`;
const flash = process.argv.includes("--flash");
const official = process.argv.includes("--check-official");
const finishFile = process.argv
  .find((a) => a.startsWith("--finish-existing="))
  ?.slice(18);
const resume = finishFile
  ? JSON.parse(await readFile(finishFile, "utf8"))
  : null;
assert(!(flash && official), "Choose one operation");
const name = "BW150-6321-APP-1-1-0-UPP.bin";
const bytes = await readFile(`Firmware&Software/${name}`);
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  "009e6b5c344c26e8d4949293248241fa65d9d053f4577ef17e38569fe8ae99ad",
);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find(
  (t) => t.type === "page" && t.title === "Atorch Load",
);
assert(target, "Start the debug app with ATORCH_DEBUG_PORT=9223");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const pending = new Map();
let request = 0;
socket.addEventListener("message", (event) => {
  const value = JSON.parse(event.data);
  const task = pending.get(value.id);
  if (!task) return;
  pending.delete(value.id);
  clearTimeout(task.timer);
  value.error
    ? task.reject(Error(JSON.stringify(value.error)))
    : task.resolve(value.result);
});
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++request;
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(Error(`CDP timeout ${method}`));
      },
      serial ? 75000 : 20000,
    );
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const value = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (value.exceptionDetails)
    throw Error(
      value.exceptionDetails.exception?.description ??
        JSON.stringify(value.exceptionDetails),
    );
  return value.result.value;
};
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
  );
const click = (text) =>
  evaluate(
    `(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Unavailable button '+${JSON.stringify(text)});b.click();})()`,
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(200);
  }
  throw Error("Native app did not reach the expected state");
}
async function screenshot(path) {
  const shot = await cdp("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: !serial,
  });
  await writeFile(path, Buffer.from(shot.data, "base64"));
}
try {
  if (process.argv.includes("--status")) {
    const output = {
      time: new Date().toISOString(),
      serial,
      pid,
      snapshot: await invoke("get_snapshot"),
      ...(serial
        ? {
            usb: await invoke("get_usb_diagnostics"),
            bluetooth: await invoke("get_bluetooth_status"),
          }
        : {}),
    };
    await writeFile(`${prefix}-status.json`, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
  } else if (process.argv.includes("--disconnect")) {
    await invoke("disconnect_device");
    console.log("Disconnected monitoring");
  } else {
    const initial = await invoke("get_snapshot");
    assert((!initial.firmware?.active || finishFile) && !initial.recording);
    if (prepareUsb) {
      assert(serial, "Root USB Host is Android only");
      if (!(await invoke("discover_devices")).length) {
        await invoke("set_root_usb_host", { enabled: true });
        await until(async () => (await invoke("discover_devices")).length);
      }
    }
    const info = await invoke("inspect_firmware", {
      name,
      dataBase64: bytes.toString("base64"),
    });
    assert.equal(info.hardwareWriteAvailable, true);
    const devices = finishFile
      ? [resume.before?.device ?? resume.snapshot.device]
      : await invoke("discover_devices");
    assert.equal(devices.length, 1, "Require a single BW150 on USB");
    const device = devices[0];
    const output = {
      time: new Date().toISOString(),
      serial,
      pid,
      info,
      device,
      initial,
      recovery,
    };
    if (official) {
      let error;
      try {
        await invoke("start_firmware", {
          path: device.path,
          name,
          dataBase64: bytes.toString("base64"),
        });
      } catch (e) {
        error = String(e);
      }
      assert.match(error ?? "", /先退出官方/);
      assert(!(await invoke("get_snapshot")).firmware?.active);
      output.rejected = error;
      await writeFile(
        `${prefix}-official-guard.json`,
        JSON.stringify(output, null, 2),
      );
      console.log(JSON.stringify({ guard: "passed", error }));
    } else if (flash || finishFile) {
      assert.equal(
        device.name,
        recovery ? "ATORCH BW150 V1.0.2" : "ATORCH BW150 V1.1.0",
      );
      if (device.serial)
        assert.equal(
          device.serial,
          recovery ? "4250313333353108" : "924415",
          "Only the explicitly authorized connected BW150",
        );
      if (!finishFile && !recovery && !initial.connected)
        await invoke("connect_device", { path: device.path });
      const before = finishFile
        ? (resume.before ?? resume.snapshot)
        : recovery
          ? JSON.parse(await readFile(baselineFile, "utf8")).before
          : await until(async () => {
              const s = await invoke("get_snapshot");
              return (
                s.connected &&
                s.telemetry &&
                s.settings &&
                s.sampleCount >= 2 &&
                s
              );
            });
      if (finishFile) {
        if (resume.before) {
          assert(
            initial.firmware.startedAt >
              (resume.initial.firmware?.startedAt ?? 0),
          );
          assert(initial.firmware.startedAt >= Date.parse(resume.time));
        } else
          assert.equal(before.firmware.startedAt, initial.firmware.startedAt);
        output.beforeSource = `${finishFile}: settings and telemetry retained from immediately before entering IAP`;
        output.acceptanceScriptResumed = true;
      }
      if (!recovery) assert.equal(before.device.path, device.path);
      assert.equal(before.telemetry.running, false);
      assert(Math.abs(before.telemetry.voltage) <= 0.05);
      output.before = before;
      if (recovery) output.beforeSource = baselineFile;
      if (!finishFile) {
        await writeFile(
          `${prefix}-acceptance.json`,
          JSON.stringify(output, null, 2),
        );
        await click("设备设置");
        await click("固件更新");
        await until(() =>
          evaluate("!!document.querySelector('[data-testid=firmware-input]')"),
        );
        await evaluate(
          `(() => {const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(name)},{type:'application/octet-stream'}));const input=document.querySelector('[data-testid=firmware-input]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        const action = recovery ? "恢复 BW150 固件…" : "升级 BW150 固件…";
        await until(() =>
          evaluate(
            `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(action)}&&!b.disabled)`,
          ),
        );
        await click(action);
        assert(
          await evaluate(
            `document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(recovery ? "ATORCH BW150 V1.0.2" : "924415")})`,
          ),
        );
        await screenshot(`${prefix}-confirmation.png`);
        await click("确认并开始");
      }
      const samples = [];
      await until(
        async () => {
          const s = await invoke("get_snapshot");
          if (
            !s.firmware ||
            (!finishFile &&
              s.firmware.startedAt === initial.firmware?.startedAt)
          ) {
            const text = await evaluate("document.body.innerText");
            if (/请先退出官方|升级.*要求|未找到所选/.test(text))
              throw Error(text);
            return false;
          }
          if (
            samples.at(-1)?.phase !== s.firmware.phase ||
            (s.firmware.active &&
              Date.now() - (samples.at(-1)?.sampledAt ?? 0) >= 5000)
          ) {
            samples.push({ ...s.firmware, sampledAt: Date.now() });
            console.log(
              `${s.firmware.phase}: ${s.firmware.acknowledgedBlocks}/${s.firmware.blocks} ${s.firmware.message}`,
            );
          }
          if (s.firmware.active) {
            output.uiLockObserved ||= await evaluate(
              "[...document.querySelectorAll('button')].find(b=>['连接设备','管理设备'].includes(b.getAttribute('aria-label'))).disabled",
            );
            if (
              !output.progressScreenshot &&
              s.firmware.acknowledgedBlocks > 1000
            ) {
              if (serial)
                await evaluate(
                  "document.querySelector('[data-testid=firmware-job]')?.scrollIntoView({block:'center'})",
                );
              await screenshot(`${prefix}-progress.png`);
              output.progressScreenshot = true;
            }
            return false;
          }
          output.finalJob = s.firmware;
          return true;
        },
        serial ? 600000 : 180000,
      );
      output.progress = samples;
      await writeFile(
        `${prefix}-acceptance.json`,
        JSON.stringify(output, null, 2),
      );
      assert.equal(output.finalJob.phase, "complete", output.finalJob.message);
      assert.equal(output.finalJob.flashConfirmed, true);
      assert.equal(output.finalJob.acknowledgedBlocks, 11088);
      output.after = await until(async () => {
        const s = await invoke("get_snapshot");
        return (
          s.connected &&
          s.settings &&
          s.telemetry &&
          s.lastReportAt > s.firmware.finishedAt &&
          s
        );
      });
      assert.equal(output.after.device.serial, "924415");
      assert.equal(output.after.device.name, "ATORCH BW150 V1.1.0");
      assert.equal(output.after.telemetry.running, false);
      assert(Math.abs(output.after.telemetry.voltage) <= 0.05);
      output.settingsUnchanged =
        JSON.stringify(output.after.settings) ===
        JSON.stringify(before.settings);
      assert(
        output.settingsUnchanged,
        "Readback settings changed across upgrade",
      );
      await screenshot(`${prefix}-complete.png`);
      const log = serial
        ? await adb(
            "exec-out",
            "run-as",
            "dev.atorch.load",
            "cat",
            output.finalJob.logPath,
          )
        : await readFile(output.finalJob.logPath, "utf8");
      const rows = log.trim().split(/\r?\n/).map(JSON.parse);
      await writeFile(
        `captures/app-firmware-${serial ? "android-" : ""}bw150${recovery ? "-recovery" : ""}-20261113.jsonl`,
        log,
      );
      const tx = rows.filter((r) => r.kind === "tx");
      const rx = rows.filter((r) => r.kind === "rx");
      assert.equal(tx.length, 11089);
      assert.equal(
        rows.filter((r) => r.kind === "tx_boot_entry").length,
        recovery ? 0 : 1,
      );
      assert.equal(tx.filter((r) => r.hex.startsWith("55 CC")).length, 11088);
      assert.equal(rx.filter((r) => r.hex.startsWith("AA EE")).length, 1);
      assert.equal(
        rx.filter((r) => r.hex.startsWith("AA FF 06 00 00 D0 31")).length,
        1,
      );
      output.audit = {
        tx: tx.length,
        rx: rx.length,
        sha256: createHash("sha256").update(log).digest("hex"),
      };
      await writeFile(
        `captures/app-firmware-${serial ? "android-" : ""}bw150${recovery ? "-recovery" : ""}-20261113.jsonl`,
        log,
      );
      await writeFile(
        `${prefix}-acceptance.json`,
        JSON.stringify(output, null, 2),
      );
      console.log(
        JSON.stringify({
          complete: true,
          settingsUnchanged: output.settingsUnchanged,
          audit: output.audit,
        }),
      );
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  }
} finally {
  socket.close();
  if (serial) await adb("forward", "--remove", `tcp:${port}`);
}
