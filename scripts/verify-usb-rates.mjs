// Explicit opt-in read-only sweep against a fresh Windows debug app.
// Changes only the host polling rate. Never calls send_command or BLE writes.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const port = Number(process.env.ATORCH_DEBUG_PORT ?? 9232);
const seconds = Number(process.env.ATORCH_RATE_SECONDS ?? 30);
assert(seconds >= 10 && seconds <= 120);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find(
  (item) => item.type === "page" && item.url === "http://tauri.localhost/",
);
assert(target, "Start the built debug app with the matching ATORCH_DEBUG_PORT");
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
socket.addEventListener("message", (event) => {
  const response = JSON.parse(event.data),
    task = pending.get(response.id);
  if (task) {
    pending.delete(response.id);
    response.error
      ? task.reject(response.error)
      : task.resolve(response.result);
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
  const response = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
const allowed = [
  "get_snapshot",
  "get_history",
  "discover_devices",
  "connect_device",
  "disconnect_device",
  "set_usb_sample_rate",
];
async function invoke(command, args = {}) {
  assert(
    allowed.includes(command),
    "Only host sampling controls and read queries are allowed",
  );
  return evaluate(
    `(window.usbRateProbe?.invoke ?? window.__TAURI_INTERNALS__.invoke)(${JSON.stringify(command)},${JSON.stringify(args)})`,
  );
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const summarize = (times) => {
  const gaps = times.slice(1).map((time, index) => time - times[index]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const mean = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  return {
    count: times.length,
    hz: 1000 / mean,
    meanMs: mean,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
};

await mkdir("artifacts/usb-rates", { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  readOnly: true,
  runs: [],
};
let connected = false;
try {
  const before = await invoke("get_snapshot");
  assert(
    !before.connected && !before.recording && !before.firmware?.active,
    "Use a fresh debug app; do not interrupt an existing user session",
  );
  const devices = await invoke("discover_devices");
  assert.equal(devices.length, 1);
  assert.equal(devices[0].serial, "924415", "Use the verified BW150 only");
  await cdp("Page.bringToFront");
  await invoke("connect_device", { path: devices[0].path });
  connected = true;
  const until = Date.now() + 5000;
  let initial;
  while (Date.now() < until) {
    initial = await invoke("get_snapshot");
    if (initial.settings && initial.telemetry && initial.sampleCount >= 2)
      break;
    await sleep(100);
  }
  assert(initial?.settings && initial?.telemetry);
  report.initial = initial;
  await evaluate(`(() => {
    const probe = window.usbRateProbe = { invoke: window.__TAURI_INTERNALS__.invoke,
      clearRect: CanvasRenderingContext2D.prototype.clearRect, polls: [], paints: [] };
    window.__TAURI_INTERNALS__.invoke = async (command, args, ...rest) => {
      const start = performance.now();
      const result = await probe.invoke(command, args, ...rest);
      if (command === "get_history") probe.polls.push({ time: start, points: result.length,
        received: performance.now(), lastTimestamp: result.at(-1)?.timestamp });
      return result;
    };
    CanvasRenderingContext2D.prototype.clearRect = function(...args) {
      if (this.canvas.closest(".trend-chart")) {
        const now = performance.now();
        if (!probe.paints.length || now - probe.paints.at(-1) > 5) probe.paints.push(now);
      }
      return probe.clearRect.apply(this, args);
    };
    return true;
  })()`);
  for (const hz of [1, 2, 5]) {
    // Use the actual visible selector, including its API and confirmed readback.
    await evaluate(`(() => {
      const select = document.querySelector('select[aria-label="USB 采样率"]');
      if (!select || select.disabled) throw new Error("USB rate selector unavailable");
      select.value = ${hz}; select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await sleep(1000);
    const snapshot = await invoke("get_snapshot");
    assert.equal(snapshot.usbSampleRateHz, hz);
    assert.equal(snapshot.connected, true);
    await evaluate(
      "window.usbRateProbe.polls = []; window.usbRateProbe.paints = []; true",
    );
    const start = await invoke("get_snapshot");
    await sleep(seconds * 1000);
    const end = await invoke("get_snapshot");
    const history = await invoke("get_history");
    const trace = await evaluate(
      "({polls:window.usbRateProbe.polls,paints:window.usbRateProbe.paints,visibility:document.visibilityState,ui:document.querySelector('select[aria-label=\"USB 采样率\"]').value})",
    );
    const rows = history.filter(
      (row) =>
        row.timestamp > start.telemetry.timestamp &&
        row.timestamp <= end.telemetry.timestamp,
    );
    assert.equal(end.connected, true);
    assert.equal(end.error, null);
    assert.deepEqual(end.settings, initial.settings, "Device settings changed");
    assert.equal(trace.visibility, "visible");
    const result = {
      requestedHz: hz,
      seconds,
      newPoints: end.sampleCount - start.sampleCount,
      sampling: summarize(rows.map((row) => row.timestamp)),
      ...(trace.polls.length > 1
        ? { uiPolling: summarize(trace.polls.map((poll) => poll.time)) }
        : {}),
      chartPainting: summarize(trace.paints),
      parametersUnchanged: true,
      rows,
      trace,
    };
    report.runs.push(result);
    await writeFile(
      "artifacts/usb-rates/native-sweep.json",
      JSON.stringify(report, null, 2),
    );
    assert(
      Math.abs(result.sampling.hz - hz) / hz < 0.03,
      "USB sampling missed its selected rate",
    );
    assert(
      Math.abs(result.chartPainting.hz - hz) / hz < 0.05,
      "Chart rendering missed its selected rate",
    );
    console.log(
      JSON.stringify({ ...result, rows: undefined, trace: undefined }),
    );
    // Save a real native screenshot of the hardware-connected monitor at each rate.
    const screenshot = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    await writeFile(
      `artifacts/usb-rates/native-${hz}hz.png`,
      Buffer.from(screenshot.data, "base64"),
    );
  }
  report.completed = true;
} finally {
  if (connected) {
    await invoke("disconnect_device");
    report.disconnected = true;
  }
  await evaluate(`(() => {const probe=window.usbRateProbe; if(probe){
    window.__TAURI_INTERNALS__.invoke=probe.invoke;
    CanvasRenderingContext2D.prototype.clearRect=probe.clearRect;
  } return true;})()`);
  await writeFile(
    "artifacts/usb-rates/native-sweep.json",
    JSON.stringify(report, null, 2),
  );
  socket.close();
}
