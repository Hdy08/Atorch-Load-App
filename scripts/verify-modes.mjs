// Opt-in real USB mode selection via the running native UI. Requires an idle
// load with zero input. Restores the original mode, never writes target/start.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const serial = process.argv
  .find((a) => a.startsWith("--android="))
  ?.split("=")[1];
const adbPath = process.env.ADB ?? "C:/Android/Sdk/platform-tools/adb.exe";
const adb = async (...args) =>
  (
    await run(adbPath, ["-s", serial, ...args], { timeout: 15000 })
  ).stdout.trim();
const pid = serial ? await adb("shell", "pidof", "dev.atorch.load") : undefined;
const port = serial
  ? await adb(
      "forward",
      "tcp:0",
      `localabstract:webview_devtools_remote_${pid}`,
    )
  : (process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ??
    "9223");
const codes = [
  "CC",
  "CV",
  "CR",
  "CP",
  "IR",
  "POWER",
  "CABLE",
  "CDC",
  "CDCDC",
  "CDxn",
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket,
  id = 0,
  initial;
const tasks = new Map();
const bluetoothReadOnly = process.argv.includes("--bluetooth-read-only");
const prefix = `artifacts/${serial ? "android" : "windows"}-${bluetoothReadOnly ? "ble-mode-ui" : "mode-switch"}`;
let invoke, click, until, selectMode;
const checks = [];
try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      target = (
        await (
          await fetch(`http://127.0.0.1:${port}/json`, {
            signal: AbortSignal.timeout(1500),
          })
        ).json()
      ).find((t) => t.type === "page" && t.title === "Atorch Load");
    } catch {}
    if (!target) await sleep(250);
  }
  assert(target, "Start a native debug window first");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const result = JSON.parse(event.data),
      task = tasks.get(result.id);
    if (!task) return;
    tasks.delete(result.id);
    clearTimeout(task.timer);
    result.error
      ? task.reject(Error(JSON.stringify(result.error)))
      : task.resolve(result.result);
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => {
        tasks.delete(request);
        reject(Error(`CDP timeout: ${method}`));
      }, 15000);
      tasks.set(request, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: request, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert(
      !response.exceptionDetails,
      JSON.stringify(response.exceptionDetails),
    );
    return response.result.value;
  };
  invoke = (command, args = {}) =>
    evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
    );
  click = (text) =>
    evaluate(
      `(() => {const button=[...document.querySelectorAll('button')].find(b=>!b.disabled && b.offsetParent!==null && (b.getAttribute('aria-label')===${JSON.stringify(text)} || b.innerText.trim()===${JSON.stringify(text)})); if (!button) throw Error('No enabled button: '+${JSON.stringify(text)});button.click();})()`,
    );
  until = async (predicate) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const value = await predicate();
      if (value) return value;
      await sleep(150);
    }
    throw Error("Device/UI did not confirm the expected mode");
  };
  selectMode = async (mode) => {
    if ((await invoke("get_snapshot")).settings?.mode === mode) return;
    if (!(await evaluate("Boolean(document.querySelector('.mode-dialog'))")))
      await click("切换测试模式");
    await click(`切换到 ${codes[mode]}`);
  };
  let snapshot = await invoke("get_snapshot");
  assert(!snapshot.recording, "Keep the existing recording intact");
  if (bluetoothReadOnly) {
    assert(snapshot.connected && snapshot.device?.transport === "bluetooth");
    assert.equal(snapshot.settings, null);
    await click("实时监控");
    const cards = await evaluate(
      "[...document.querySelectorAll('.test-mode button')].map(b=>({label:b.getAttribute('aria-label'),disabled:b.disabled}))",
    );
    assert(
      cards.length === 0 &&
        (await evaluate("!document.querySelector('.mode-switch-button')")),
      "BLE must not expose mode writes",
    );
    await mkdir("artifacts", { recursive: true });
    await sleep(450);
    const screenshot = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: !serial,
    });
    await writeFile(`${prefix}.png`, Buffer.from(screenshot.data, "base64"));
    await click("实时监控");
    await sleep(450);
    const live = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: !serial,
    });
    await writeFile(`${prefix}-live.png`, Buffer.from(live.data, "base64"));
    await evaluate(
      "document.querySelector('.trend-chart')?.scrollIntoView({block:'center'})",
    );
    await sleep(450);
    const chart = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(`${prefix}-chart.png`, Buffer.from(chart.data, "base64"));
    const canvasState = await evaluate(
      `(() => {const el=document.querySelector('.trend-chart');return {html:el?.outerHTML,rect:el?.getBoundingClientRect().toJSON(),canvases:[...el.querySelectorAll('canvas')].map(c=>{const pixels=c.getContext('2d')?.getImageData(0,0,c.width,c.height).data;let painted=0;for(let i=3;i<(pixels?.length??0);i+=4)if(pixels[i])painted++;return {width:c.width,height:c.height,painted};})};})()`,
    );
    assert(
      canvasState.canvases.some((c) => c.painted > 0),
      "The native chart canvas must contain rendered pixels",
    );
    if (serial) {
      await adb("shell", "screencap", "-p", "/sdcard/atorch-modes-chart.png");
      await adb(
        "pull",
        "/sdcard/atorch-modes-chart.png",
        `${prefix}-chart-native.png`,
      );
      await adb("shell", "rm", "/sdcard/atorch-modes-chart.png");
    }
    await evaluate("window.scrollTo(0,0)");
    const after = await invoke("get_snapshot");
    assert(after.connected);
    await writeFile(
      `${prefix}.json`,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          serial,
          pid,
          cards,
          modeControlsAbsent: true,
          canvasState,
          connected: after.connected,
          sampleCount: after.sampleCount,
        },
        null,
        2,
      ),
    );
    console.log(
      "Native BLE panel omits USB mode controls; monitoring preserved",
    );
  } else {
    if (!snapshot.connected) {
      const devices = await invoke("discover_devices");
      assert(devices.length, "Connect a BW150 USB device first");
      await invoke("connect_device", { path: devices[0].path });
    }
    snapshot = await until(async () => {
      const s = await invoke("get_snapshot");
      return s.settings && s.telemetry && s.connected && s;
    });
    assert.notEqual(
      snapshot.device?.transport,
      "bluetooth",
      "Mode control requires USB",
    );
    assert.equal(snapshot.telemetry.running, false, "Stop the load first");
    assert.equal(
      snapshot.telemetry.voltage,
      0,
      "This check requires zero input",
    );
    assert(snapshot.settings.mode >= 0 && snapshot.settings.mode <= 9);
    initial = snapshot;
    await click("实时监控");
    for (let mode = 0; mode < codes.length; mode++) {
      await selectMode(mode);
      let readback = await until(async () => {
        const s = await invoke("get_snapshot");
        const active = await evaluate(
          `document.querySelector('.mode-code')?.textContent.trim()`,
        );
        const ready = await evaluate(
          `!document.querySelector('.mode-dialog') && !!document.querySelector('.mode-switch-button:not(:disabled)')`,
        );
        return (
          s.settings?.mode === mode && active === codes[mode] && ready && s
        );
      });
      if (mode >= 4) {
        readback = await until(async () => {
          const s = await invoke("get_snapshot");
          return s.specialTest?.reading.mode === mode && s;
        });
        const r = readback.specialTest.reading;
        assert.equal(r.resistance, readback.telemetry.resistance);
        assert.equal(r.energy, readback.telemetry.energy);
        assert.equal(r.capacity, readback.telemetry.capacity);
        assert.equal(r.stageCode, readback.telemetry.stageCode);
      }
      assert.equal(readback.telemetry.running, false);
      const { target: _target, mode: _mode, ...rest } = readback.settings;
      const {
        target: _oldTarget,
        mode: _oldMode,
        ...original
      } = initial.settings;
      assert.deepEqual(
        rest,
        original,
        "Mode selection must preserve shared parameters",
      );
      checks.push({
        mode,
        code: codes[mode],
        settings: readback.settings,
        running: readback.telemetry.running,
        specialTest: readback.specialTest,
      });
      console.log(`${codes[mode]} confirmed; load stopped`);
    }
    await selectMode(initial.settings.mode);
    const restored = await until(async () => {
      const s = await invoke("get_snapshot");
      return s.settings?.mode === initial.settings.mode && s;
    });
    assert.equal(
      restored.settings.target,
      initial.settings.target,
      "Restore the mode's original target",
    );
    assert.equal(restored.telemetry.running, false);
    await mkdir("artifacts", { recursive: true });
    const screenshot = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    await writeFile(`${prefix}.png`, Buffer.from(screenshot.data, "base64"));
    await writeFile(
      `${prefix}.json`,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          serial,
          pid,
          initial,
          checks,
          restored,
        },
        null,
        2,
      ),
    );
    console.log(
      `All ${checks.length} modes confirmed; restored ${codes[initial.settings.mode]}`,
    );
    initial = undefined;
  }
} finally {
  try {
    if (initial && invoke && click && until) {
      await click("实时监控").catch(() => {});
      if (
        (await invoke("get_snapshot")).settings?.mode !== initial.settings.mode
      ) {
        await selectMode(initial.settings.mode);
        await until(
          async () =>
            (await invoke("get_snapshot")).settings?.mode ===
            initial.settings.mode,
        );
      }
    }
  } finally {
    if (socket) socket.close();
    if (serial) await adb("forward", "--remove", `tcp:${port}`).catch(() => {});
  }
}
