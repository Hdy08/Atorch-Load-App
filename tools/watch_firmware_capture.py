"""Passively attach the capture tool to a newly opened official app instance."""
import argparse
from pathlib import Path
import subprocess
import sys
import time

import frida

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--exclude-pid', type=int, default=0)
parser.add_argument('--seconds', type=float, default=1200)
parser.add_argument('--stop-file', required=True)
parser.add_argument('--minimal', action='store_true')
args = parser.parse_args()
seen = {args.exclude_pid}
workers = []
end = time.monotonic() + args.seconds
try:
    while time.monotonic() < end and not Path(args.stop_file).exists():
        for process in frida.get_local_device().enumerate_processes():
            if process.name.lower() != 'load_application.exe' or process.pid in seen:
                continue
            seen.add(process.pid)
            output = f'captures/vendor-fw-retry-{process.pid}.jsonl'
            command = [
                sys.executable, str(Path(__file__).with_name('capture_firmware.py')),
                '--pid', str(process.pid), '--output', output,
                '--seconds', str(max(1, end-time.monotonic())),
                '--stop-file', args.stop_file,
            ]
            if args.minimal:
                command.append('--minimal')
            worker = subprocess.Popen(command)
            workers.append(worker)
            print(f'Passive capture attached to new PID {process.pid}: {output}', flush=True)
        time.sleep(0.5)
finally:
    # The same stop-file ends each capture cleanly; never stops the official app.
    for worker in workers:
        if worker.poll() is None:
            worker.wait(timeout=10)
