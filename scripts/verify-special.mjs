// Native app acceptance: inspect real user-supplied firmware and rehearse every
// block without entering a real bootloader or sending a device command.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const serial = process.argv.find((a) => a.startsWith("--android="))?.slice(10);
const adbPath = process.env.ADB ?? "C:/Android/Sdk/platform-tools/adb.exe";
const adb = async (...args) =>
  (
    await run(adbPath, ["-s", serial, ...args], { timeout: 15000 })
  ).stdout.trim();
const pid = serial ? await adb("shell", "pidof", "dev.atorch.load") : null;
let port,
  socket,
  id = 0;
const pending = new Map();
const prefix = `artifacts/${serial ? "android" : "windows"}-${process.argv.includes("--firmware-release") ? "firmware-rehearsal" : "special-firmware"}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  port = serial
    ? await adb(
        "forward",
        "tcp:0",
        `localabstract:webview_devtools_remote_${pid}`,
      )
    : "9223";
  const target = (
    await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  ).find((t) => t.type === "page" && t.title === "Atorch Load");
  assert(target, "Start the debug app first");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(event.data);
    const task = pending.get(value.id);
    if (!task) return;
    pending.delete(value.id);
    clearTimeout(task.timer);
    if (value.error) task.reject(Error(JSON.stringify(value.error)));
    else task.resolve(value.result);
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(Error(`CDP timeout ${method}`));
      }, 20000);
      pending.set(request, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: request, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.exception?.description ??
          JSON.stringify(r.exceptionDetails),
      );
    return r.result.value;
  };
  const invoke = (name, args = {}) =>
    evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`,
    );
  const click = (text) =>
    evaluate(
      `(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Unavailable button '+${JSON.stringify(text)});b.click();})()`,
    );
  const until = async (task) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const result = await task();
      if (result) return result;
      await sleep(150);
    }
    throw Error("Native UI did not reach the expected state");
  };
  const initial = await invoke("get_snapshot");
  assert(!initial.recording, "Leave active user recording intact");
  const files = ["BW150-6321-APP-1-1-0-UPP.bin", "BW600-6321-APP-2-0-5-UP.bin"];
  const inspections = [];
  for (const name of files) {
    const bytes = await readFile(`Firmware&Software/${name}`);
    const info = await invoke("inspect_firmware", {
      name,
      dataBase64: bytes.toString("base64"),
    });
    assert.equal(info.bytes, bytes.length);
    assert.equal(info.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(info.blocks, Math.ceil(bytes.length / 58));
    assert.equal(info.remainder, bytes.length % 58);
    assert.equal(info.hardwareWriteAvailable, name.startsWith("BW150-"));
    const result = await invoke("rehearse_firmware", {
      name,
      dataBase64: bytes.toString("base64"),
    });
    assert.equal(result.offline, true);
    assert.equal(result.phase, "complete");
    assert.equal(result.acknowledgedBlocks, info.blocks);
    assert.equal(result.transferredBytes, bytes.length);
    inspections.push({ info, result });
  }
  const rejected = [];
  for (const [name, bytes] of [
    ["empty.bin", Buffer.alloc(0)],
    ["BW150-wrong-header.bin", Buffer.alloc(128)],
    [
      "DL24EW-573-V1.1.0_app.bin",
      await readFile("Firmware&Software/DL24EW-573-V1.1.0_app.bin"),
    ],
  ]) {
    let error;
    try {
      await invoke("inspect_firmware", {
        name,
        dataBase64: bytes.toString("base64"),
      });
    } catch (e) {
      error = String(e);
    }
    assert(error, `${name} must not be accepted as AC632N`);
    rejected.push({ name, error });
  }
  await click("设备设置");
  await click("固件更新");
  await until(() =>
    evaluate("!!document.querySelector('[data-testid=firmware-input]')"),
  );
  const bytes = await readFile(`Firmware&Software/${files[0]}`);
  await evaluate(
    `(() => {const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(files[0])},{type:'application/octet-stream'}));const input=document.querySelector('[data-testid=firmware-input]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(() =>
    evaluate(
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='离线预演升级握手'&&!b.disabled)",
    ),
  );
  await click("离线预演升级握手");
  await until(() =>
    evaluate(
      "document.querySelector('[data-testid=firmware-rehearsal]')?.textContent.includes('协议预演完成')",
    ),
  );
  await evaluate(
    "document.querySelector('[data-testid=firmware-rehearsal]').scrollIntoView({block:'center'})",
  );
  await sleep(450);
  const screenshot = await cdp("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: !serial,
  });
  await writeFile(`${prefix}.png`, Buffer.from(screenshot.data, "base64"));
  if (serial) {
    const temporary = "/sdcard/atorch-special-firmware.png";
    await adb("shell", "screencap", "-p", temporary);
    await adb("pull", temporary, `${prefix}-native.png`);
    await adb("shell", "rm", temporary);
    assert.equal(await adb("shell", "pidof", "dev.atorch.load"), pid);
  }
  const after = await invoke("get_snapshot");
  assert.equal(after.connected, initial.connected);
  assert.deepEqual(
    after.settings,
    initial.settings,
    "Rehearsal must preserve actual device parameters",
  );
  assert.equal(after.telemetry?.running, initial.telemetry?.running);
  if (initial.connected)
    assert(
      after.sampleCount > initial.sampleCount,
      "Monitoring must continue during rehearsal",
    );
  const report = {
    timestamp: new Date().toISOString(),
    serial,
    pid,
    initial,
    after,
    inspections,
    rejected,
  };
  await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2));
  await click("实时监控");
  await evaluate("window.scrollTo(0,0)");
  console.log(
    `Native firmware inspection and full rehearsal passed; ${inspections.map((i) => i.info.blocks).join(" + ")} blocks validated; monitoring preserved`,
  );
} finally {
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(Error("Closing debug session"));
  }
  socket?.close();
  if (serial && port) await adb("forward", "--remove", `tcp:${port}`);
}
