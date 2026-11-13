"""Opt-in, named BW150 BLE probes through the installed reference application.

The default operation only records notifications. --connect connects the named
BW150 through the reference BLE service. A command is sent once, without retries;
only the reversible backlight/tariff settings and the four reference panel keys
are exposed here. Clearing counters is deliberately not a probe operation.
"""
import argparse
import json
from pathlib import Path
import time

import frida
import frida_tools

parser = argparse.ArgumentParser()
parser.add_argument("pid", type=int)
parser.add_argument("--server", default="127.0.0.1:27045")
parser.add_argument("--connect")
parser.add_argument("--command", choices=["backlight", "tariff", "set", "ok", "plus", "minus"])
parser.add_argument("--value", type=int, default=0)
parser.add_argument("--query-usb", choices=["ffe1", "ffe2"], help="Read-only USB parameter/telemetry queries on a named characteristic")
parser.add_argument("--padded", action="store_true", help="Use the complete 64-byte read query")
parser.add_argument("--seconds", type=int, default=8)
parser.add_argument("--output", default="captures/ble-probe.jsonl")
args = parser.parse_args()
bridge = (Path(frida_tools.__file__).parent / "bridges/java.js").read_text(encoding="utf-8")
agent = r"""
globalThis.Java = bridge;
const hex = a => Array.from(a, b => (b & 255).toString(16).padStart(2,'0')).join('');
Java.perform(() => {
  const Service = Java.use('com.tang.etest.e_test.Model.BLEService');
  Service.broadcastByte.implementation = function(action,data) {
    send({direction:'notify', hex:hex(data)});
    return this.broadcastByte(action,data);
  };
  Service.send.implementation = function(data) {
    send({direction:'write', hex:hex(data)});
    return this.send(data);
  };
  const Callback=Java.use('com.tang.etest.e_test.Model.BLEService$2');
  Callback.onCharacteristicWrite.implementation=function(g,c,status) {
    send({direction:'write-status',uuid:c.getUuid().toString(),status});
    return this.onCharacteristicWrite(g,c,status);
  };
  send({direction:'ready'});
});
rpc.exports.connect = address => new Promise((resolve,reject) => Java.perform(() => {
  let found=false;
  Java.choose('com.tang.etest.e_test.Model.BLEService', {
    onMatch(s) {
      if (found) return;
      found=true;
      const service=Java.retain(s);
      Java.scheduleOnMainThread(() => {
        try {service.connect(address); resolve(true);} catch(e) {reject(e);}
        finally {service.$dispose();}
      });
    },
    onComplete() {if(!found) reject(Error('Reference BLE service is not running'));}
  });
}));
rpc.exports.state = () => Java.performNow(() => {
  const Service=Java.use('com.tang.etest.e_test.Model.BLEService');
  const g=Service.mBluetoothGatt.value;
  const services=[];
  if(g) {
    const S=Java.use('android.bluetooth.BluetoothGattService');
    const C=Java.use('android.bluetooth.BluetoothGattCharacteristic');
    const ss=g.getServices();
    for(let i=0;i<ss.size();i++) {
      const s=Java.cast(ss.get(i),S), cs=s.getCharacteristics(), chars=[];
      for(let j=0;j<cs.size();j++) {
        const c=Java.cast(cs.get(j),C);
        chars.push({uuid:c.getUuid().toString(),properties:c.getProperties()});
      }
      services.push({uuid:s.getUuid().toString(),chars});
    }
  }
  return {connected:Service.CONTENT_STATUS.value, address:g?g.getDevice().getAddress():null,services};
});
rpc.exports.command = (command,value) => Java.performNow(() => {
  const Service=Java.use('com.tang.etest.e_test.Model.BLEService');
  if(!Service.CONTENT_STATUS.value) throw Error('Reference app is not connected');
  const codes={backlight:0x21,tariff:0x22,set:0x31,ok:0x32,plus:0x33,minus:0x34};
  if(!(command in codes)) throw Error('Unknown named probe');
  if(command==='backlight' && (!Number.isInteger(value)||value<0||value>60)) throw Error('Backlight range');
  if(command==='tariff' && (!Number.isInteger(value)||value<1||value>999999)) throw Error('Tariff range');
  if(command!=='backlight' && command!=='tariff' && value!==0) throw Error('Key payload must be zero');
  const b=[255,85,17,2,codes[command],0,(value>>>16)&255,(value>>>8)&255,value&255,0];
  b[9]=(b.slice(2,9).reduce((a,b)=>a+b,0)^0x44)&255;
  Service.send(Java.array('byte',b.map(n=>n>127?n-256:n)));
  return hex(b);
});
rpc.exports.query = (characteristic,padded,kind) => Java.performNow(() => {
  const Service=Java.use('com.tang.etest.e_test.Model.BLEService');
  const UUID=Java.use('java.util.UUID');
  const g=Service.mBluetoothGatt.value;
  if(!g || !Service.CONTENT_STATUS.value) throw Error('Reference app is not connected');
  const c=g.getService(UUID.fromString('0000ffe0-0000-1000-8000-00805f9b34fb')).getCharacteristic(UUID.fromString('0000'+characteristic+'-0000-1000-8000-00805f9b34fb'));
  const b=[0x55,5,1,kind,11,0,0x8c,0xee,0xff];
  if(padded) while(b.length<64)b.push(0);
  c.setValue(Java.array('byte',b.map(n=>n>127?n-256:n)));
  c.setWriteType(2);
  const accepted=g.writeCharacteristic(c);
  send({direction:'query',characteristic,padded,hex:hex(b),accepted});
  return accepted;
});
"""
path = Path(args.output)
path.parent.mkdir(exist_ok=True, parents=True)
device = frida.get_device_manager().add_remote_device(args.server)
session = device.attach(args.pid)
with path.open("a", encoding="utf-8") as stream:
    def emit(row):
        stream.write(json.dumps({"time": time.time(), **row}, ensure_ascii=False) + "\n")
        stream.flush()
        if row.get("direction") != "notify":
            print(json.dumps(row, ensure_ascii=False), flush=True)

    script = session.create_script(bridge + "\n" + agent)
    script.on("message", lambda message, data: emit(message.get("payload", message)))
    try:
        script.load()
        if args.connect:
            script.exports_sync.connect(args.connect)
            time.sleep(4)
        emit({"direction": "state", **script.exports_sync.state()})
        time.sleep(2)
        if args.command:
            emit({"direction": "probe", "command": args.command, "value": args.value,
                  "hex": script.exports_sync.command(args.command, args.value)})
        if args.query_usb:
            script.exports_sync.query(args.query_usb,args.padded,3)
            time.sleep(2)
            script.exports_sync.query(args.query_usb,args.padded,5)
        time.sleep(args.seconds)
    finally:
        script.unload()
        session.detach()
