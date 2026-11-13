// Explicit native UI check: reads an existing local recording, never controls
// the load. --png saves a new curve image; Android waits for the system picker.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";

const run = promisify(execFile);
const serial = process.argv
  .find((a) => a.startsWith("--android="))
  ?.split("=")[1];
const adbPath = process.env.ADB ?? "C:/Android/Sdk/platform-tools/adb.exe";
const adb = async (...args) =>
  (
    await run(adbPath, ["-s", serial, ...args], {
      timeout: 15000,
      maxBuffer: 2_000_000,
    })
  ).stdout.trim();
const pid = serial ? await adb("shell", "pidof", "dev.atorch.load") : undefined;
if (serial)
  assert(/^\d+$/.test(pid), "Start the Android debug application first");
const port = serial
  ? await adb(
      "forward",
      "tcp:0",
      `localabstract:webview_devtools_remote_${pid}`,
    )
  : (process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ??
    "9223");
const tasks = new Map();
let socket,
  id = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target;
  const deadline = Date.now() + 10000;
  while (!target && Date.now() < deadline) {
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
  assert(target, "No Atorch Load debug WebView found");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((yes, no) => {
    socket.addEventListener("open", yes, { once: true });
    socket.addEventListener("error", no, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const response = JSON.parse(event.data),
      task = tasks.get(response.id);
    if (!task) return;
    tasks.delete(response.id);
    clearTimeout(task.timer);
    response.error
      ? task.reject(new Error(JSON.stringify(response.error)))
      : task.resolve(response.result);
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => {
        tasks.delete(request);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      tasks.set(request, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: request, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const invoke = (command, args = {}) =>
    evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
    );
  const before = await invoke("get_snapshot");
  console.log(
    JSON.stringify({
      serial,
      pid,
      connected: before.connected,
      recording: before.recording,
      telemetry: before.telemetry,
    }),
  );
  if (process.argv.includes("--probe"))
    process.exitCode = before.recording ? 2 : 0;
  else {
    assert(
      !before.recording,
      "A user recording is active; leave the session intact",
    );
    const files = await invoke("list_recordings");
    const selected = files
      .filter((f) => !f.active && f.bytes <= 50_000_000)
      .sort((a, b) => b.bytes - a.bytes)[0];
    assert(selected, "No completed recording available for this check");
    const content = await invoke("read_recording", { name: selected.name });
    const count = content.trim().split(/\r?\n/).length - 1;
    const click = (text) =>
      evaluate(
        `(() => { const button = [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && (b.getAttribute('aria-label') === ${JSON.stringify(text)} || b.innerText.trim() === ${JSON.stringify(text)})); if (!button) throw Error('Button missing: ' + ${JSON.stringify(text)}); button.click(); })()`,
      );
    const until = async (expression, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const value = await evaluate(expression);
        if (value) return value;
        await sleep(200);
      }
      throw new Error(`UI did not settle: ${expression}`);
    };
    await click("数据记录");
    await until(
      "[...document.querySelectorAll('[role=tab]')].some(button => button.innerText.trim() === '历史记录')",
    );
    await click("历史记录");
    await until(
      `document.querySelector('.recording-list')?.textContent.includes(${JSON.stringify(selected.name)})`,
    );
    await evaluate(
      `(() => { const row = [...document.querySelectorAll('.recording-entry')].find(row => row.textContent.includes(${JSON.stringify(selected.name)})); row.querySelector('button').click(); })()`,
    );
    await until(
      `document.querySelector('.review-heading')?.textContent.includes(${JSON.stringify(`${count.toLocaleString("en-US")} / ${count.toLocaleString("en-US")}`)})`,
    );
    let styles = false;
    if (process.argv.includes("--styles")) {
      await click("应用设置");
      await click("曲线");
      await until(
        "!!document.querySelector('form[aria-label=\"曲线与坐标设置\"]')",
      );
      assert(await evaluate("!document.querySelector('[role=dialog]')"));
      assert(
        await evaluate(
          "!!document.querySelector('input[aria-label=电压颜色]') && !!document.querySelector('input[aria-label=电压线宽]')",
        ),
      );
      await sleep(450);
      const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
      await mkdir("artifacts", { recursive: true });
      await writeFile(
        `artifacts/${serial ? "android" : "windows"}-curve-settings.png`,
        Buffer.from(screenshot.data, "base64"),
      );
      await click("数据记录");
      styles = true;
    }
    let csv;
    if (process.argv.includes("--csv")) {
      const savedPath =
        "document.body.innerText.match(/已导出：([^\\n]+)/)?.[1]";
      const previous = await evaluate(savedPath);
      await click("导出 CSV");
      console.log("CSV_SAVE_STARTED; Android: complete the system file picker");
      csv = {
        path: await until(
          `(${savedPath}) && (${savedPath}) !== ${JSON.stringify(previous ?? null)} && (${savedPath})`,
          60000,
        ),
      };
      if (!serial) {
        const text = await readFile(csv.path, "utf8");
        csv.samples = text.trim().split(/\r?\n/).length - 1;
        assert.equal(csv.samples, count);
      }
    }
    let image;
    if (process.argv.includes("--png")) {
      const savedPath =
        "document.body.innerText.match(/曲线图片已保存：([^\\n]+)/)?.[1]";
      const previous = await evaluate(savedPath);
      await until("document.querySelector('.trend-chart canvas')?.width > 0");
      await click("截图");
      console.log("PNG_SAVE_STARTED; Android: complete the system file picker");
      image = {
        path: await until(
          `(${savedPath}) && (${savedPath}) !== ${JSON.stringify(previous ?? null)} && (${savedPath})`,
          60000,
        ),
      };
      if (!serial) {
        const bytes = await readFile(image.path);
        assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        image.bytes = bytes.length;
        image.width = bytes.readUInt32BE(16);
        image.height = bytes.readUInt32BE(20);
      }
    }
    const after = await invoke("get_snapshot");
    assert.equal(after.connected, before.connected);
    assert.equal(after.recording, before.recording);
    if (before.connected)
      assert(
        after.sampleCount >= before.sampleCount,
        "Live sampling was interrupted",
      );
    const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
    const name = serial ? "android" : "windows";
    await mkdir("artifacts", { recursive: true });
    await writeFile(
      `artifacts/${name}-data-review.png`,
      Buffer.from(screenshot.data, "base64"),
    );
    const report = {
      timestamp: new Date().toISOString(),
      serial,
      pid,
      recording: selected,
      loadedSamples: count,
      image,
      csv,
      beforeSamples: before.sampleCount,
      afterSamples: after.sampleCount,
      connected: after.connected,
      styles,
    };
    await writeFile(
      `artifacts/${name}-data-review.json`,
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
} finally {
  socket?.close();
  for (const task of tasks.values()) clearTimeout(task.timer);
  if (serial) await adb("forward", "--remove", `tcp:${port}`);
}
