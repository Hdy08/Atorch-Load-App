"""Print command-construction instructions for recovered MainDialog slots."""
import struct
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
p=pefile.PE('BW600_PC_Application_V1.0.8/Load_Application.exe')
b=p.OPTIONAL_HEADER.ImageBase
d=p.get_memory_mapped_image()
u=lambda a:struct.unpack_from('<I',d,a-b)[0]
cs=Cs(CS_ARCH_X86,CS_MODE_32)
entries=[]
for i in range(106):
    h=0x59fa40+u(0x59ef20+(u(0x59ef20+20)+i*5)*4)*16
    off=h-b+struct.unpack_from('<i',d,h-b+12)[0]
    name=d[off:].split(b'\0',1)[0].decode()
    dst=u(0x59ed60+i*4)
    call=next((x for x in cs.disasm(d[dst-b:dst-b+100],dst) if x.mnemonic=='call'),None)
    if call: entries.append((int(call.op_str,16),name))
addresses=sorted({a for a,n in entries})
for addr,name in entries:
    if not any(t in name for t in ['on_settings_', 'lineEdit_', 'on_disp_Btn_Run', 'CDPop']): continue
    end=next((a for a in addresses if a>addr),addr+0x400)
    print(f'\n{name} {addr:#x}')
    for x in cs.disasm(d[addr-b:end-b],addr):
        lhs=x.op_str.split(',')[0]
        if (x.mnemonic=='mov' and (lhs.startswith('byte ptr [ebp') or lhs.startswith('word ptr [ebp') or lhs=='dword ptr [ebp - 0x55]') and '6666' not in x.op_str) or x.mnemonic in ['fmul','fdiv']:
            print(f'  {x.address:x} {x.mnemonic} {x.op_str}')
