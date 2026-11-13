"""Passively capture the official app's HID and libusb traffic during an update.

Does not replace functions, modify buffers, or generate device traffic. Start
before operating the official app. JSONL includes both API intent and completed
USB transfers, keeping those layers distinct. Use --stop-file for clean shutdown.
"""
import argparse
import json
from pathlib import Path
import threading
import time

import frida


SOURCE = r"""
const hooked = new Set();
const callbacks = new Set();
let sequence = 0;
function hex(p, n) {
  if (n < 0 || n > 4096 || p.isNull()) return null;
  return Array.from(new Uint8Array(p.readByteArray(n))).map(x => x.toString(16).padStart(2, '0')).join('');
}
function event(kind, data) { send({sequence: ++sequence, timeMs: Date.now(), thread: Process.getCurrentThreadId(), kind, ...data}); }
function safe(task) { try { task(); } catch (e) { event('hook_error', {error: String(e)}); } }
function attach(mod, name, hooks) {
  const address = mod.findExportByName(name);
  if (!address || hooked.has(address.toString())) return;
  Interceptor.attach(address, hooks);
  hooked.add(address.toString());
  event('hook', {module: mod.name, name, address: address.toString()});
}
function transfer(p) {
  if (Process.pointerSize !== 4) throw Error('This libusb_transfer layout requires the official 32-bit app');
  return {pointer:p.toString(), handle:p.readPointer().toString(), flags:p.add(4).readU8(), endpoint:p.add(5).readU8(), type:p.add(6).readU8(), timeout:p.add(8).readU32(), status:p.add(12).readS32(), length:p.add(16).readS32(), actual:p.add(20).readS32(), callback:p.add(24).readPointer(), buffer:p.add(32).readPointer()};
}
Process.attachModuleObserver({onAdded(mod) {
  safe(() => {
    if (!MINIMAL && /^(kernel32|kernelbase)\.dll$/i.test(mod.name)) attach(mod,'WriteFile',{
      onEnter(args) { safe(() => {const n=args[2].toInt32();if(n<64||n>66)return;const b=args[1];const h=hex(b,Math.min(4,n));if(!h.startsWith('0055')&&!h.startsWith('55'))return;this.report={handle:args[0].toString(),length:n,hex:hex(b,n)};}); },
      onLeave(value) { if(this.report)event('windows_write_file',{...this.report,result:value.toInt32()}); }
    });
    if (/load_application/i.test(mod.name)) {
      event('app', {name:mod.name, path:mod.path, base:mod.base.toString(), pointerSize:Process.pointerSize});
      for (const name of (MINIMAL ? ['hid_write','hid_read'] : ['hid_write', 'hid_send_feature_report', 'hid_read', 'hid_read_timeout'])) {
        attach(mod, name, {
          onEnter(args) { safe(() => {this.at=Date.now();this.handle=args[0].toString();this.buffer=args[1];this.length=args[2].toInt32();this.output=name==='hid_write'||name==='hid_send_feature_report';if(this.output)this.hex=hex(this.buffer,this.length);}); },
          onLeave(value) { safe(() => {const result=value.toInt32();if(this.output||result>0)event(name,{startedMs:this.at,handle:this.handle,length:this.length,result,hex:this.output?this.hex:hex(this.buffer,result)});}); }
        });
      }
      for (const name of ['hid_open', 'hid_open_path', 'hid_close']) attach(mod,name,{
        onEnter(args) { safe(() => {this.meta=name==='hid_open'?{vid:args[0].toInt32(),pid:args[1].toInt32(),serial:args[2].isNull()?null:args[2].readUtf16String()}:name==='hid_open_path'?{path:args[0].readUtf8String()}:{handle:args[0].toString()};}); },
        onLeave(value) { safe(() => event(name,{...this.meta,result:value.toString()})); }
      });
    }
    if (!MINIMAL && /^libusb-1\.0\.dll$/i.test(mod.name)) {
      attach(mod,'libusb_get_device_descriptor',{
        onEnter(args) { this.buffer=args[1]; },
        onLeave(value) { safe(() => {if(value.toInt32()===0)event('usb_device_descriptor',{hex:hex(this.buffer,18)});}); }
      });
      for (const name of ['libusb_interrupt_transfer','libusb_bulk_transfer']) attach(mod,name,{
        onEnter(args) { safe(() => {this.at=Date.now();this.endpoint=args[1].toInt32();this.buffer=args[2];this.length=args[3].toInt32();this.actual=args[4];this.timeout=args[5].toInt32();if(!(this.endpoint&128))this.hex=hex(this.buffer,this.length);}); },
        onLeave(value) { safe(() => {const result=value.toInt32();const actual=this.actual.isNull()?null:this.actual.readS32();if(!(this.endpoint&128)||actual>0||result!==-7)event(name,{startedMs:this.at,endpoint:this.endpoint,length:this.length,actual,result,timeout:this.timeout,hex:this.endpoint&128?hex(this.buffer,actual??0):this.hex});}); }
      });
      attach(mod,'libusb_control_transfer',{
        onEnter(args) { safe(() => {this.at=Date.now();this.type=args[1].toInt32();this.request=args[2].toInt32();this.value=args[3].toInt32();this.index=args[4].toInt32();this.buffer=args[5];this.length=args[6].toInt32();if(!(this.type&128))this.hex=hex(this.buffer,this.length);}); },
        onLeave(value) { safe(() => {const result=value.toInt32();event('libusb_control_transfer',{startedMs:this.at,requestType:this.type,request:this.request,value:this.value,index:this.index,length:this.length,result,hex:this.type&128?hex(this.buffer,Math.max(0,result)):this.hex});}); }
      });
      attach(mod,'libusb_submit_transfer',{
        onEnter(args) { safe(() => {const t=transfer(args[0]);this.pointer=t.pointer;
          const key=t.callback.toString();
          if(!t.callback.isNull()&&!callbacks.has(key)) {
            Interceptor.attach(t.callback,{onEnter(args) {safe(() => {const t=transfer(args[0]);if(t.actual>0||t.status!==2)event('libusb_complete',{...t,callback:t.callback.toString(),buffer:t.buffer.toString(),capturedLength:Math.max(0,Math.min(t.actual,t.length)),hex:hex(t.buffer,Math.max(0,Math.min(t.actual,t.length)))});});}});
            callbacks.add(key);event('callback_hook',{address:key});
          }
          if(!(t.endpoint&128))event('libusb_submit_out',{...t,callback:key,buffer:t.buffer.toString(),hex:hex(t.buffer,t.length)});
        }); },
        onLeave(value) { safe(() => {if(value.toInt32()!==0)event('libusb_submit_error',{pointer:this.pointer,result:value.toInt32()});}); }
      });
    }
  });
}});
event('ready', {});
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', required=True, type=int)
    parser.add_argument('--seconds', type=float, default=900)
    parser.add_argument('--output', required=True)
    parser.add_argument('--stop-file')
    parser.add_argument('--minimal', action='store_true', help='Only HID writes/reads and open/close; reduce instrumentation overhead')
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    stop_file = Path(args.stop_file) if args.stop_file else None
    detached = threading.Event()
    lock = threading.Lock()
    count = 0
    with output.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps({'kind': 'capture_metadata', 'pid': args.pid,
                                 'frida': frida.__version__, 'passive': True, 'minimal': args.minimal,
                                 'capturedAt': time.time()}) + '\n')

        def message(item, _data):
            nonlocal count
            payload = item.get('payload', item)
            payload['capturedAt'] = time.time()
            with lock:
                stream.write(json.dumps(payload, ensure_ascii=False) + '\n')
                count += 1
                if payload.get('kind') in ('app', 'ready', 'hook_error'):
                    stream.flush()
                    print(json.dumps(payload, ensure_ascii=False), flush=True)

        session = frida.attach(args.pid)
        session.on('detached', lambda *_: detached.set())
        script = session.create_script('const MINIMAL = '+str(args.minimal).lower()+';\n'+SOURCE)
        script.on('message', message)
        script.load()
        end = time.monotonic() + args.seconds
        try:
            while time.monotonic() < end and not detached.wait(0.5):
                with lock:
                    stream.flush()
                if stop_file and stop_file.exists():
                    break
        finally:
            if not detached.is_set():
                session.detach()
            with lock:
                stream.flush()
        print(f'Captured {count} passive events to {output}', flush=True)


if __name__ == '__main__':
    main()
