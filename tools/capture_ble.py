"""Opt-in BLE trace of E-test on the user's rooted Android device.

Forward a root Frida server first. Hooks preserve every original call and do
do not issue device commands by default. --query-usb explicitly probes only the
known USB settings read query; it never sends writes/clear/start commands.
APK/decompiled code and traces stay in ignored dirs.
"""
import argparse
import json
import pathlib
import time

import frida
import frida_tools

parser = argparse.ArgumentParser()
parser.add_argument("pid", type=int)
parser.add_argument("--server", default="127.0.0.1:27045")
parser.add_argument("--seconds", type=int, default=15)
parser.add_argument("--query-usb", action="store_true", help="Probe only the already-known USB parameter/telemetry read queries over FFE1")
args = parser.parse_args()
out = pathlib.Path("captures/ble-vendor.jsonl")
out.parent.mkdir(exist_ok=True)
device = frida.get_device_manager().add_remote_device(args.server)
session = device.attach(args.pid)
bridge = (pathlib.Path(frida_tools.__file__).parent / "bridges/java.js").read_text(encoding="utf-8")
agent = r"""
globalThis.Java = bridge;
Java.perform(() => {
  const hex = a => Array.from(a, b => (b & 255).toString(16).padStart(2,'0')).join('');
  const Service = Java.use('com.tang.etest.e_test.Model.BLEService');
  Service.broadcastByte.implementation = function(action, data) {
    send({direction:'notify', hex:hex(data)});
    return this.broadcastByte(action,data);
  };
  Service.send.implementation = function(data) {
    send({direction:'write', hex:hex(data)});
    return this.send(data);
  };
  const g = Service.mBluetoothGatt.value;
  if (g) {
    const ServiceClass = Java.use('android.bluetooth.BluetoothGattService');
    const Characteristic = Java.use('android.bluetooth.BluetoothGattCharacteristic');
    const services = g.getServices();
    const info=[];
    for (let i=0;i<services.size();i++) {
      const s=Java.cast(services.get(i),ServiceClass); const cs=s.getCharacteristics(); const chars=[];
      for (let j=0;j<cs.size();j++) {
        const c=Java.cast(cs.get(j),Characteristic);chars.push({uuid:c.getUuid().toString(),properties:c.getProperties()});
      }
      info.push({uuid:s.getUuid().toString(),chars});
    }
    send({direction:'services',info});
  }
  send({direction:'ready'});
});
rpc.exports.query = () => Java.performNow(() => {
  const Service = Java.use('com.tang.etest.e_test.Model.BLEService');
  Service.send(Java.array('byte',[0x55,5,1,3,11,0,-116,-18,-1]));
});
"""
with out.open("a", encoding="utf-8") as stream:
    def on_message(message, data):
        row = {"time": time.time(), **message}
        stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        stream.flush()
        print(json.dumps(message, ensure_ascii=False), flush=True)

    script = session.create_script(bridge + "\n" + agent)
    script.on("message", on_message)
    script.load()
    try:
        if args.query_usb:
            time.sleep(1)
            script.exports_sync.query()
        time.sleep(args.seconds)
    finally:
        script.unload()
        session.detach()
