"""Observe the vendor app's HID calls without changing device traffic.

Usage: python tools/capture_vendor.py --pid 26180 --seconds 12
Requires frida. Output is local JSONL, ignored by Git.
"""
import argparse
import json
from pathlib import Path
import time
import frida

parser = argparse.ArgumentParser()
parser.add_argument('--pid', required=True, type=int)
parser.add_argument('--seconds', type=float, default=12)
parser.add_argument('--output', default='captures/vendor.jsonl')
args = parser.parse_args()
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
source = r"""
const app = Process.enumerateModules()[0];
send({kind: 'module', name: app.name, base: app.base.toString()});
for (const name of ['hid_write', 'hid_send_feature_report', 'hid_read', 'hid_read_timeout', 'hid_open', 'hid_open_path']) {
  const address = app.findExportByName(name);
  if (!address) continue;
  Interceptor.attach(address, {
    onEnter(args) {
      this.name = name;
      if (name === 'hid_open') { send({kind: name, vid: args[0].toInt32(), pid: args[1].toInt32()}); return; }
      if (name === 'hid_open_path') { send({kind: name, path: args[0].readUtf8String()}); return; }
      this.buffer = args[1]; this.length = args[2].toInt32();
      if (name === 'hid_write' || name === 'hid_send_feature_report') {
        send({kind: name, length: this.length, hex: Array.from(new Uint8Array(this.buffer.readByteArray(Math.min(this.length, 256)))).map(x=>x.toString(16).padStart(2,'0')).join('')});
      }
    },
    onLeave(value) {
      const size = value.toInt32();
      if ((name === 'hid_read' || name === 'hid_read_timeout') && size > 0) {
        send({kind: name, length: size, hex: Array.from(new Uint8Array(this.buffer.readByteArray(Math.min(size, 256)))).map(x=>x.toString(16).padStart(2,'0')).join('')});
      }
    }
  });
}
"""
with output.open('w', encoding='utf-8') as stream:
    count = [0]
    def message(item, _data):
        payload = item.get('payload', item)
        payload['capturedAt'] = time.time()
        stream.write(json.dumps(payload, ensure_ascii=False) + '\n')
        stream.flush()
        if count[0] < 8:
            print(json.dumps(payload, ensure_ascii=False), flush=True)
        count[0] += 1
    session = frida.attach(args.pid)
    script = session.create_script(source)
    script.on('message', message)
    script.load()
    time.sleep(args.seconds)
    session.detach()
    print(f'Captured {count[0]} events to {output}')
