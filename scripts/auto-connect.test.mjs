import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AutomaticConnection } from "../apps/app/src/lib/autoConnect.ts";

const usb = { path: "usb://bw150", name: "BW150", serial: "123" };
const ble = { path: "ble://bw150", name: "BW150_BLE", serial: "" };
const until = async (check) => {
  const end = Date.now() + 1000;
  while (!check()) {
    assert(Date.now() < end, "automatic connection did not settle");
    await sleep(5);
  }
};
function fixture(options = {}) {
  const calls = [];
  let connected = false;
  let result;
  const api = {
    snapshot: async () => ({
      connected,
      firmware: options.firmware ? { active: true } : null,
    }),
    discover: async () => {
      calls.push("usb");
      return options.usb ?? [];
    },
    bluetoothStatus: async () => ({
      supported: true,
      enabled: true,
      permission: options.permission !== false,
      locationRequired: false,
    }),
    discoverBluetooth: async () => {
      calls.push("ble");
      return options.scan ? options.scan() : [ble];
    },
    stopBluetoothScan: async () => {
      calls.push("stop");
      options.stop?.();
    },
    connect: async (path) => {
      calls.push(path);
      if (options.fail === path) throw new Error("open failed");
      connected = true;
    },
  };
  const controller = new AutomaticConnection(
    api,
    () => {},
    (next) => {
      result = next;
    },
    { initial: 0, retry: 15 },
  );
  return {
    api,
    calls,
    controller,
    get result() {
      return result;
    },
  };
}

test("automatic connection uses USB without scanning BLE", async () => {
  const f = fixture({ usb: [usb] });
  await f.controller.setEnabled(true);
  await until(() => f.result);
  await f.controller.setEnabled(false);
  assert.deepEqual(f.calls, ["usb", usb.path]);
});

test("failed USB candidates fall back to BLE after a second USB check", async () => {
  const f = fixture({ usb: [usb], fail: usb.path });
  await f.controller.setEnabled(true);
  await until(() => f.result);
  await f.controller.setEnabled(false);
  assert.deepEqual(f.calls, ["usb", usb.path, "ble", "usb", ble.path]);
});

test("USB arriving during a BLE scan takes priority", async () => {
  const f = fixture({
    scan: async () => {
      f.api.discover = async () => {
        f.calls.push("usb");
        return [usb];
      };
      return [ble];
    },
  });
  await f.controller.setEnabled(true);
  await until(() => f.result);
  await f.controller.setEnabled(false);
  assert.deepEqual(f.calls, ["usb", "ble", "usb", usb.path]);
});

test("suspending automatic discovery drains the cancelled scan before manual use", async () => {
  let finish;
  const f = fixture({
    scan: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    stop: () => finish([ble]),
  });
  await f.controller.setEnabled(true);
  await until(() => finish);
  await f.controller.setEnabled(false);
  assert.deepEqual(f.calls, ["usb", "ble", "stop"]);
  assert.equal(f.result, undefined);
});

test("firmware jobs and IAP interfaces are never opened automatically", async () => {
  const f = fixture({ firmware: true, usb: [usb] });
  await f.controller.setEnabled(true);
  await sleep(20);
  await f.controller.setEnabled(false);
  assert.deepEqual(f.calls, []);
  const iap = fixture({ usb: [{ ...usb, serial: "IAP" }] });
  await iap.controller.setEnabled(true);
  await until(() => iap.result);
  await iap.controller.setEnabled(false);
  assert(!iap.calls.includes(usb.path));
  assert(iap.calls.includes(ble.path));
});

test("permission denial is requested once while USB keeps retrying", async () => {
  const f = fixture({
    permission: false,
    scan: async () => {
      throw new Error("denied");
    },
  });
  await f.controller.setEnabled(true);
  await until(() => f.calls.filter((c) => c === "usb").length >= 4);
  await f.controller.setEnabled(false);
  assert.equal(f.calls.filter((c) => c === "ble").length, 1);
  assert.equal(f.result, undefined);
});

test("connection resumes scanning after loss without overlapping scan cycles", async () => {
  const f = fixture({ usb: [usb] });
  await f.controller.setEnabled(true);
  await until(() => f.result);
  await f.controller.setEnabled(false);
  f.api.snapshot = async () => ({ connected: false });
  f.api.connect = async (path) => {
    f.calls.push(path);
    f.api.snapshot = async () => ({ connected: true });
  };
  await f.controller.setEnabled(true);
  await until(() => f.calls.filter((c) => c === usb.path).length === 2);
  await f.controller.setEnabled(false);
  assert.equal(f.calls.filter((c) => c === "usb").length, 2);
});

for (const [preference, expected] of [
  ["prefer-ble", ["ble", ble.path]],
  ["usb-only", ["usb", usb.path]],
  ["ble-only", ["ble", ble.path]],
]) {
  test(`automatic connection respects ${preference}`, async () => {
    const f = fixture({ usb: [usb] });
    await f.controller.configure(preference);
    await f.controller.setEnabled(true);
    await until(() => f.result);
    await f.controller.setEnabled(false);
    assert.deepEqual(f.calls, expected);
  });
}
test("BLE priority falls back to USB when BLE is unavailable", async () => {
  const f = fixture({ usb: [usb], fail: ble.path });
  await f.controller.configure("prefer-ble");
  await f.controller.setEnabled(true);
  await until(() => f.result);
  await f.controller.setEnabled(false);
  assert.deepEqual(f.calls, ["ble", ble.path, "usb", usb.path]);
});
test("off never scans either transport and USB-only never requests BLE permission", async () => {
  for (const preference of ["off", "usb-only"]) {
    const f = fixture();
    await f.controller.configure(preference);
    await f.controller.setEnabled(true);
    await sleep(45);
    await f.controller.setEnabled(false);
    assert(!f.calls.includes("ble"));
    if (preference === "off") assert.deepEqual(f.calls, []);
    else assert(f.calls.includes("usb"));
  }
});
test("changing transport policy drains the old BLE scan before starting the new scan", async () => {
  let finish;
  const f = fixture({
    usb: [],
    scan: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    stop: () => finish([ble]),
  });
  await f.controller.setEnabled(true);
  await until(() => finish);
  await f.controller.configure("usb-only");
  f.api.discover = async () => {
    f.calls.push("usb");
    return [usb];
  };
  await f.controller.setEnabled(true);
  await until(() => f.result);
  await f.controller.setEnabled(false);
  assert.deepEqual(f.calls, ["usb", "ble", "stop", "usb", usb.path]);
});
