"""Verify the BW150 target command by writing back its current value unchanged."""
import hid,time
d=hid.device();d.open(0x0483,0x5750)
try:
    settings=None
    d.write(bytes([0])+bytes.fromhex('550501030b008ceeff')+bytes(55))
    until=time.monotonic()+2
    while time.monotonic()<until:
        data=bytes(d.read(64,200))
        if len(data)==64 and data[:4]==bytes.fromhex('aa050103'):
            settings=data;break
    if settings is None:raise RuntimeError('No settings; no write performed')
    frame=bytes.fromhex('55050121')+settings[4:8]+bytes.fromhex('eeff')+bytes(54)
    print('Writing unchanged target:',frame[:10].hex(),flush=True)
    print('write result',d.write(bytes([0])+frame),flush=True)
    until=time.monotonic()+2;seen=set()
    while time.monotonic()<until:
        data=bytes(d.read(64,200))
        if data and data.hex() not in seen:seen.add(data.hex());print(data.hex(),flush=True)
finally:d.close()
