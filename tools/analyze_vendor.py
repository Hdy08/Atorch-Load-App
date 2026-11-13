"""Recover Qt5 metadata and selected disassembly from the local vendor binary."""
import argparse
import struct
from pathlib import Path
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

arg = argparse.ArgumentParser()
arg.add_argument('--address', type=lambda s:int(s, 0))
arg.add_argument('--size', type=lambda s:int(s, 0), default=0x300)
arg.add_argument('--slot')
args = arg.parse_args()
pe = pefile.PE('BW600_PC_Application_V1.0.8/Load_Application.exe')
base = pe.OPTIONAL_HEADER.ImageBase
data = pe.get_memory_mapped_image()
def u32(addr): return struct.unpack_from('<I', data, addr - base)[0]
def cstr(addr): return data[addr-base:].split(b'\0',1)[0].decode('utf-8','replace')
if args.slot:
    header, metadata, table = 0x59fa40,0x59ef20,0x59ed60
    cs = Cs(CS_ARCH_X86, CS_MODE_32)
    for i in range(u32(metadata+16)):
        idx=u32(metadata+(u32(metadata+20)+i*5)*4)
        sh=header+idx*16
        name=cstr(sh+struct.unpack_from('<i',data,sh-base+12)[0])
        dest=u32(table+i*4)
        call=next((ins for ins in cs.disasm(data[dest-base:dest-base+100],dest) if ins.mnemonic=='call'),None)
        if call and (args.slot=='all' or args.slot.lower() in name.lower()):
            print(f'{i:3} {name:50} {call.op_str}')
elif args.address:
    cs = Cs(CS_ARCH_X86, CS_MODE_32)
    for ins in cs.disasm(data[args.address-base:args.address-base+args.size], args.address):
        print(f'{ins.address:08x} {ins.mnemonic:8} {ins.op_str}')
else:
    for class_name in [None]:
        for pos in range(0, len(data)-16, 4):
            ref, size, alloc, offset = struct.unpack_from('<iIIi', data, pos)
            if ref != -1 or not 2 <= size <= 60 or alloc != 0: continue
            if not 0 <= pos+offset < len(data): continue
            raw_name = data[pos+offset:pos+offset+size]
            if not raw_name.isascii() or not raw_name.replace(b'_',b'').isalnum() or data[pos+offset+size:pos+offset+size+1] != b'\0': continue
            class_name = raw_name.decode()
            header = pos+base
            needle = struct.pack('<I',header)
            p = 0
            while True:
                p = data.find(needle,p)
                if p < 0: break
                p += 1
                if p % 4 != 1 or p+12>=len(data): continue
                metadata = u32(p-1+base+4)
                callback = u32(p-1+base+8)
                if not base < metadata < base+len(data) or not base < callback < base+len(data): continue
                revision = u32(metadata)
                if revision not in (7,8): continue
                count, methods_offset = u32(metadata+16),u32(metadata+20)
                print(f'CLASS {class_name} header={header:#x} metadata={metadata:#x} static_metacall={callback:#x} methods={count}')
                for i in range(count):
                    idx = u32(metadata + (methods_offset+i*5)*4)
                    sh = header+idx*16
                    print(f'  {i:3} {cstr(sh + struct.unpack_from("<i",data,sh-base+12)[0])}')
