"""Read-only q32s listing of an unpacked BW150 application.

Unpack a COPY of the vendor firmware with kagaimiq/jl-misctools first. This tool
uses pypcode and kagaimiq/ghidra-jieli from --isa; neither is a runtime dependency.
Compile q32s.slaspec with pypcode's sleigh executable before running this tool.
Original firmware, extracted binaries and listings stay in ignored directories.
"""
import argparse
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument("--isa", default=".local/ghidra-jieli/data/languages")
parser.add_argument("--pypcode", default=".local/q32-python")
parser.add_argument("--app", default="artifacts/vendor-bw150-firmware/files/app.bin")
parser.add_argument("--base", type=lambda s: int(s, 0), default=0x1E00120)
parser.add_argument("--address", type=lambda s: int(s, 0))
parser.add_argument("--size", type=lambda s: int(s, 0), default=0x400)
parser.add_argument("--output")
args = parser.parse_args()
sys.path.insert(0, str(Path(args.pypcode).resolve()))
import pypcode

data = Path(args.app).read_bytes()
definition = ET.parse(Path(args.isa) / "JieLi.ldefs").find("language[@id='q32s:LE:32:default']")
if definition is None:
    parser.error("The ISA directory does not contain the q32s language definition")
if args.size <= 0 or (args.address is not None and not args.base <= args.address < args.base + len(data)):
    parser.error("Use a positive size and an address inside the extracted application")
context = pypcode.Context(pypcode.ArchLanguage(str(Path(args.isa).resolve()), definition))
out = []
off = (args.address or args.base) - args.base
end = min(len(data), off + args.size) if args.address else len(data)
while off < end:
    try:
        insn = context.disassemble(data[off:off+16], args.base+off, max_instructions=1).instructions[0]
        size = insn.length
        text = insn.mnem + " " + insn.body
        for match in re.finditer(r"0x[0-9a-fA-F]+", text):
            value = int(match.group(), 16)
            if args.base <= value < args.base + len(data):
                raw = data[value-args.base:].split(b"\0", 1)[0][:180]
                if len(raw) >= 4 and all(32 <= c <= 126 or c in (9,10,13) for c in raw):
                    text += " ; " + repr(raw.decode("ascii"))
    except (pypcode.BadDataError, pypcode.DecoderError):
        text = ".short 0x" + data[off:off+2][::-1].hex()
        size = 2
    out.append(f"{args.base+off:08x} {data[off:off+size].hex():<12} {text}")
    off += size
result = "\n".join(out) + "\n"
if args.output:
    Path(args.output).write_text(result, encoding="utf-8")
else:
    print(result, end="")
