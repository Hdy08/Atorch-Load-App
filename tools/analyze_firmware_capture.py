"""Verify passive official-update captures against the original firmware bytes.

Uses hid_write/hid_read as the canonical layer (hid_read_timeout is nested and
would double-count). USB submit/completion and Windows WriteFile remain evidence
of API wrapping, not claims that return counts are physical USB payload lengths.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path


def crc16(data):
    crc = 0xffff
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xa001 if crc & 1 else 0)
    return crc


def packet(kind, payload):
    body = bytes([kind, len(payload)+4]) + payload
    return body + crc16(body).to_bytes(2, 'little')


def wire(logical, prefix):
    return (bytes([prefix]) + logical + bytes(64))[:64]


def analyze(path, image):
    events = []
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            # A live capture can end with an unfinished line.
            continue
    size = len(image)
    blocks = (size+57)//58
    handshake = packet(0xaa, blocks.to_bytes(2, 'little') + bytes([size % 58]))
    writes, replies, failures = [], [], []
    written = collections.Counter()
    acknowledged = collections.Counter()
    types = collections.Counter()
    evidence = {}
    write_handles, read_handles = collections.Counter(), collections.Counter()
    handshake_handles = set()
    foreign_replies = 0
    for event in events:
        kind = event.get('kind')
        raw = bytes.fromhex(event.get('hex') or '')
        if kind == 'hid_write' and raw.startswith(b'\x55\xaa'):
            handshake_handles.add(event['handle'])
            if raw != wire(handshake, 0x55):
                failures.append({'sequence': event['sequence'], 'reason': 'Handshake differs from file'})
            evidence.setdefault('handshake', event)
            types['AA'] += 1
        if kind == 'hid_write' and raw.startswith(b'\x55\xcc'):
            index = int.from_bytes(raw[3:5], 'little')
            expected = packet(0xcc, index.to_bytes(2, 'little') + image[index*58:(index+1)*58])
            if index >= blocks or raw != wire(expected, 0x55):
                failures.append({'sequence': event['sequence'], 'reason': 'CC bytes/CRC differ from file', 'index': index})
            written[index] += 1
            write_handles[event['handle']] += 1
            writes.append(event)
            evidence.setdefault('firstBlock', event)
            evidence['lastBlock'] = event
            types['CC'] += 1
        if kind != 'hid_read' or len(raw) != 64 or raw[0] != 0xaa or raw[1] not in (0xbb, 0xdd, 0xee, 0xff, 0x11):
            continue
        name = f'{raw[1]:02X}'
        types[name] += 1
        read_handles[event['handle']] += 1
        if event['handle'] not in handshake_handles:
            foreign_replies += 1
        replies.append(event)
        evidence.setdefault(name, event)
        if raw[1] == 0xbb:
            if raw != wire(packet(0xbb, blocks.to_bytes(2, 'little') + bytes([size % 58])), 0xaa):
                failures.append({'sequence': event['sequence'], 'reason': 'BB does not echo handshake'})
        elif raw[1] == 0xdd:
            index = int.from_bytes(raw[3:5], 'little')
            payload = index.to_bytes(2, 'little') + image[index*58:(index+1)*58]
            expected = wire(packet(0xdd, payload), 0xaa)
            if index >= blocks or raw != expected:
                failures.append({'sequence': event['sequence'], 'reason': 'DD echo/CRC differs', 'index': index, 'actual': raw.hex(), 'expected': expected.hex()})
            acknowledged[index] += 1
        else:
            length = raw[2]
            if length >= 4 and length <= 63:
                body = raw[1:1+length]
                if crc16(body[:-2]) != int.from_bytes(body[-2:], 'little'):
                    failures.append({'sequence': event['sequence'], 'reason': name+' CRC invalid'})
            if raw[1] == 0xee:
                index = int.from_bytes(raw[3:5], 'little')
                expected = wire(packet(0xee, index.to_bytes(2, 'little')+image[index*58:(index+1)*58]),0xaa)
                if index != blocks-1 or index not in written or raw != expected:
                    failures.append({'sequence':event['sequence'],'reason':'EE does not confirm the final block'})
                else:
                    acknowledged[index] += 1
            if raw[1] == 0xff and raw != wire(packet(0xff,b'\0\0'),0xaa):
                failures.append({'sequence':event['sequence'],'reason':'FF completion status/CRC differs'})
    missing = [index for index in range(blocks) if index not in written]
    unacknowledged = [index for index in written if index not in acknowledged]
    complete = not missing and not unacknowledged and not failures and types['EE'] > 0 and types['FF'] > 0 and types['11'] == 0
    return {
        'source': str(path), 'captureSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'events': len(events), 'firmwareBytes': size, 'firmwareSha256': hashlib.sha256(image).hexdigest(),
        'expectedBlocks': blocks, 'types': dict(types), 'writtenUnique': len(written),
        'acknowledgedUnique': len(acknowledged), 'lastWrittenIndex': max(written, default=None),
        'missingBlocks': len(missing), 'unacknowledgedIndices': unacknowledged[:30],
        'duplicateWrites': {i:n for i,n in written.items() if n>1},
        'duplicateReplies': sum(n-1 for n in acknowledged.values()),
        'writeHandles': dict(write_handles), 'readHandles': dict(read_handles),
        'foreignHandleReplies': foreign_replies, 'verificationFailures': failures,
        'complete': complete, 'evidence': evidence,
        'durationMs': writes[-1]['timeMs']-writes[0]['startedMs'] if writes else None,
        'wrapping': '64 bytes: TX 55 + first 63 logical bytes; RX AA + first 63 logical bytes. Full 58-byte blocks omit CRC high byte; all data and CRC low byte are present.',
        'captureCaveat': 'Initial capture version may read one extra byte from OUT completion when libusb reports actual=65 for requested length=64. That extra byte is excluded from canonical HID verification and is not treated as transmitted data.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('captures', nargs='+', type=Path)
    parser.add_argument('--firmware', required=True, type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    image = args.firmware.read_bytes()
    reports = [analyze(path, image) for path in args.captures]
    if args.out:
        args.out.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding='utf-8')
    for report in reports:
        print(json.dumps({k:v for k,v in report.items() if k not in ('evidence','verificationFailures')},ensure_ascii=False,indent=2))
        print('verificationFailures:', len(report['verificationFailures']))
        if report['verificationFailures']:
            print(json.dumps(report['verificationFailures'][:2],ensure_ascii=False))


if __name__ == '__main__':
    main()
