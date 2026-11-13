// Shared opt-in QA connection to this project's debug Tauri application.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
const run = promisify(execFile);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function debugApp(serial, desktopPort = "9223") {
  const adb = async (...args) => {
    assert(serial, "ADB is only available for the selected Android device");
    return (
      await run(
        process.env.ADB || "C:/Android/Sdk/platform-tools/adb.exe",
        ["-s", serial, ...args],
        { timeout: 20000, maxBuffer: 16000000 },
      )
    ).stdout;
  };
  const pid = serial
    ? (await adb("shell", "pidof", "dev.atorch.load")).trim()
    : null;
  if (serial)
    assert(/^\d+$/.test(pid), "Start Atorch Load on the Android device");
  const port = serial
    ? (
        await adb(
          "forward",
          "tcp:0",
          `localabstract:webview_devtools_remote_${pid}`,
        )
      ).trim()
    : desktopPort;
  let socket;
  const pending = new Map();
  let request = 0;
  try {
    let target;
    for (let i = 0; i < 30 && !target; i++) {
      try {
        target = (
          await (
            await fetch(`http://127.0.0.1:${port}/json`, {
              signal: AbortSignal.timeout(1000),
            })
          ).json()
        ).find((t) => t.type === "page" && t.title === "Atorch Load");
      } catch {}
      if (!target) await sleep(200);
    }
    assert(target, "No Atorch Load debug WebView found");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(event.data),
        task = pending.get(value.id);
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
            reject(Error(`CDP timeout: ${method}`));
          },
          serial ? 75000 : 20000,
        );
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await cdp("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.exception?.value ||
            JSON.stringify(result.exceptionDetails),
        );
      return result.result.value;
    };
    return {
      serial,
      pid,
      adb,
      cdp,
      evaluate,
      invoke: (command, args = {}) =>
        evaluate(
          `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
        ),
      click: (text) =>
        evaluate(
          `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&b.getClientRects().length);if(!b||b.disabled)throw Error('Unavailable button '+${JSON.stringify(text)});b.scrollIntoView({block:'center'});b.click();})()`,
        ),
      screenshot: async (path) => {
        const result = await cdp("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: !serial,
        });
        await writeFile(path, Buffer.from(result.data, "base64"));
      },
      close: async () => {
        socket.close();
        for (const task of pending.values()) clearTimeout(task.timer);
        pending.clear();
        if (serial) await adb("forward", "--remove", `tcp:${port}`);
      },
    };
  } catch (error) {
    socket?.close();
    if (serial) await adb("forward", "--remove", `tcp:${port}`).catch(() => {});
    throw error;
  }
}

export async function until(task, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await task();
    if (value) return value;
    await sleep(200);
  }
  throw Error("Native application did not reach the expected state");
}
