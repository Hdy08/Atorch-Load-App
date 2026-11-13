// Opt-in integration check against the real, running Windows app.
// Only writes the target's current value and STOP. It never enables the load.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const targets = await (await fetch("http://127.0.0.1:9223/json")).json();
const target = targets.find(
  (t) => t.type === "page" && /localhost|127\.0\.0\.1|tauri/.test(t.url),
);
assert(target, "Start the debug app with ATORCH_DEBUG_PORT=9223");
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
await new Promise((yes, no) => {
  socket.addEventListener("open", yes, { once: true });
  socket.addEventListener("error", no, { once: true });
});
socket.addEventListener("message", (event) => {
  const response = JSON.parse(event.data);
  const callback = pending.get(response.id);
  if (callback) {
    pending.delete(response.id);
    response.error
      ? callback.reject(new Error(JSON.stringify(response.error)))
      : callback.resolve(response.result);
  }
});
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
  );
if (process.argv.includes("--inspect")) {
  console.log(
    JSON.stringify(
      {
        snapshot: await invoke("get_snapshot"),
        ui: await evaluate("document.body.innerText"),
      },
      null,
      2,
    ),
  );
  socket.close();
  process.exit(0);
}
if (process.argv.includes("--disconnect")) {
  await invoke("disconnect_device");
  socket.close();
  process.exit(0);
}
async function until(predicate, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out");
}
async function click(text) {
  assert(
    await evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled);if(!b)return false;b.click();return true;})()`,
    ),
    `Button not found: ${text}`,
  );
}
await mkdir("artifacts", { recursive: true });
if (process.argv.includes("--read-only")) {
  try {
    if (!(await invoke("get_snapshot")).connected) {
      const devices = await invoke("discover_devices");
      assert(devices.length, "No BW150 connected");
      await invoke("connect_device", { path: devices[0].path });
    }
    const snapshot = await until(async () => {
      const s = await invoke("get_snapshot");
      return (
        s.connected && s.telemetry && s.settings && s.sampleCount >= 2 && s
      );
    });
    await click("实时监控");
    if (process.argv.includes("--verify-csv")) {
      assert(
        !snapshot.recording,
        "An existing recording is active; keep it intact",
      );
      let recording;
      try {
        await invoke("set_recording", { enabled: true });
        recording = (await invoke("get_snapshot")).recording;
        const count = (await invoke("get_snapshot")).sampleCount;
        await until(
          async () => (await invoke("get_snapshot")).sampleCount >= count + 4,
        );
      } finally {
        await invoke("set_recording", { enabled: false });
      }
      assert(recording);
      const content = await readFile(recording, "utf8");
      const row = content.trim().split("\n").at(-1).split(",").map(Number);
      assert.equal(row[4], snapshot.telemetry.resistance);
      assert.equal(row[5], snapshot.telemetry.energy);
      assert.equal(row[6], snapshot.telemetry.capacity);
      const exported = await invoke("export_csv");
      const saved = await invoke("save_csv", {
        name: `Atorch_verified_${Date.now()}.csv`,
        content: await readFile(exported, "utf8"),
      });
      assert.equal(
        await readFile(saved, "utf8"),
        await readFile(exported, "utf8"),
      );
      console.log(
        JSON.stringify(
          { recording, exported, saved, csvFieldOrderVerified: true },
          null,
          2,
        ),
      );
    }
    await until(() =>
      evaluate(
        `document.body.innerText.includes('${snapshot.telemetry.energy.toFixed(3)}')`,
      ),
    );
    const png = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    await writeFile(
      "artifacts/windows-connected.png",
      Buffer.from(png.data, "base64"),
    );
    const result = {
      passed: true,
      testedAt: new Date().toISOString(),
      device: snapshot.device.name,
      telemetry: snapshot.telemetry,
      settings: snapshot.settings,
      readOnly: true,
    };
    await writeFile(
      "artifacts/windows-readback.json",
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    socket.close();
  }
  process.exit(0);
}
try {
  await invoke("disconnect_device");
  await click("实时监控");
  const devices = await invoke("discover_devices");
  assert(devices.length, "No BW150 connected");
  await until(() =>
    evaluate(
      `!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='连接设备')`,
    ),
  );
  await click("连接设备");
  await until(() =>
    evaluate(
      `!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='连接')`,
    ),
  );
  await click("连接");
  await until(async () => {
    const s = await invoke("get_snapshot");
    return s.connected && s.settings && s.telemetry && s.sampleCount >= 2 && s;
  });
  const before = await invoke("get_snapshot");
  assert.equal(
    before.telemetry.running,
    false,
    "This test requires the load to be in standby",
  );
  await invoke("send_command", {
    command: { kind: "target", value: before.settings.target },
  });
  await invoke("send_command", { command: { kind: "running", value: 0 } });
  await invoke("set_recording", { enabled: true });
  const recording = await until(
    async () => (await invoke("get_snapshot")).recording,
  );
  const started = (await invoke("get_snapshot")).sampleCount;
  await until(
    async () => (await invoke("get_snapshot")).sampleCount >= started + 8,
    15000,
  );
  await invoke("set_recording", { enabled: false });
  await until(async () => !(await invoke("get_snapshot")).recording);
  const recorded = await readFile(recording, "utf8");
  assert(recorded.includes("VOLTAGE(V)"));
  assert(recorded.trim().split("\n").length >= 9);
  const exported = await invoke("export_csv");
  assert((await readFile(exported, "utf8")).includes("FAN_SPEED(RPM)"));
  const after = await invoke("get_snapshot");
  assert.deepEqual(after.settings, before.settings, "Device settings changed");
  assert.equal(after.telemetry.running, false);
  const png = await cdp("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await writeFile(
    "artifacts/windows-connected.png",
    Buffer.from(png.data, "base64"),
  );
  await click("数据记录");
  await cdp("DOM.enable");
  const doc = await cdp("DOM.getDocument");
  const input = await cdp("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "input[type=file][accept*=csv]",
  });
  await cdp("DOM.setFileInputFiles", {
    nodeId: input.nodeId,
    files: [
      resolve(
        "BW600_PC_Application_V1.0.8/Data/LoadData_2026_05_06_22_002.csv",
      ),
    ],
  });
  await until(() =>
    evaluate(
      `document.body.innerText.includes('LoadData_2026_05_06_22_002.csv')`,
    ),
  );
  assert(
    await evaluate(`document.querySelectorAll('tbody tr').length>0`),
    "Legacy CSV did not populate the history table",
  );
  await invoke("disconnect_device");
  assert.equal((await invoke("get_snapshot")).connected, false);
  await invoke("connect_device", { path: devices[0].path });
  await until(async () => (await invoke("get_snapshot")).sampleCount >= 2);
  const result = {
    passed: true,
    testedAt: new Date().toISOString(),
    device: devices[0].name,
    checks: [
      "UI USB discovery and connection",
      "real telemetry",
      "unchanged target readback",
      "STOP readback",
      "recording 8+ samples",
      "native CSV export",
      "legacy vendor CSV import",
      "disconnect/reconnect",
    ],
    recording,
    exported,
    settingsPreserved: true,
    loadEnabled: false,
    samplesBeforeReconnect: after.sampleCount,
  };
  await writeFile(
    "artifacts/windows-verification.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket.close();
}
