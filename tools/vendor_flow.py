"""Annotate local vendor disassembly with imported APIs and literal strings.

Read-only analysis of the user supplied reference; never opens a USB device.
"""
import argparse
import struct
from pathlib import Path

import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from capstone.x86 import X86_OP_IMM, X86_OP_MEM

parser = argparse.ArgumentParser()
parser.add_argument("address", type=lambda value: int(value, 0))
parser.add_argument("--size", type=lambda value: int(value, 0), default=0x400)
parser.add_argument("--out")
args = parser.parse_args()
pe = pefile.PE("BW600_PC_Application_V1.0.8/Load_Application.exe")
base = pe.OPTIONAL_HEADER.ImageBase
data = pe.get_memory_mapped_image()
imports = {
    entry.address: (entry.name or b"ordinal").decode(errors="replace")
    for library in pe.DIRECTORY_ENTRY_IMPORT
    for entry in library.imports
}
cs = Cs(CS_ARCH_X86, CS_MODE_32)
cs.detail = True


def literal(address):
    offset = address - base
    if not 0 <= offset < len(data) - 24:
        return None
    # Qt QStringLiteral / QByteArrayData header, followed by UTF-16 text.
    ref, size, alloc, relative = struct.unpack_from("<iIIi", data, offset)
    if ref == -1 and 1 <= size <= 500 and alloc == 0 and 0 < relative < 4096:
        text = data[offset + relative:offset + relative + size * 2].decode("utf-16le", "replace")
        return repr(text)
    raw = data[offset:offset + 500].split(b"\0", 1)[0]
    if len(raw) >= 3:
        try:
            text = raw.decode("utf-8")
            if all(character.isprintable() or character in "\n\r\t" for character in text):
                return repr(text)
        except UnicodeDecodeError:
            pass
    return None


lines = []
for instruction in cs.disasm(data[args.address - base:args.address - base + args.size], args.address):
    annotations = []
    for operand in instruction.operands:
        address = operand.imm if operand.type == X86_OP_IMM else operand.mem.disp if operand.type == X86_OP_MEM else 0
        if address in imports:
            annotations.append(imports[address])
        elif base <= address < base + len(data):
            value = literal(address)
            if value:
                annotations.append(value)
    suffix = " ; " + " | ".join(annotations) if annotations else ""
    lines.append(f"{instruction.address:08x} {instruction.mnemonic:8} {instruction.op_str}{suffix}")
output = "\n".join(lines)
if args.out:
    Path(args.out).write_text(output, encoding="utf-8")
else:
    print(output)
