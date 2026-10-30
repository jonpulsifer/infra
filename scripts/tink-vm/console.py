"""Run one shell command on a VM's serial console and print what it wrote.

console.py SOCKET TIMEOUT COMMAND... writes COMMAND to the shell on the serial
socket between two markers, waits for the end marker and exits with the
command's status, or 124 when TIMEOUT seconds pass first.
"""

import os
import re
import socket
import sys
import time


def main() -> int:
    path, timeout, *words = sys.argv[1:]
    deadline = time.monotonic() + float(timeout)
    tag = f"T{os.getpid()}"
    done = re.compile(rf"\n{tag}-END (\d+)")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(path)
    s.settimeout(1)
    s.sendall(f"\recho {tag}-BEGIN; ( {' '.join(words)} ) 2>&1; echo {tag}-END $?\r".encode())
    buf = ""
    while time.monotonic() < deadline:
        try:
            chunk = s.recv(65536).decode(errors="replace")
        except socket.timeout:
            continue
        if not chunk:
            break
        buf += chunk
        m = done.search(buf)
        if m:
            start = buf.rfind(f"\n{tag}-BEGIN")
            print(buf[start + len(tag) + 7 : m.start()].replace("\r", "").strip("\n"))
            return int(m.group(1))
    print(buf[-4000:].replace("\r", ""))
    print("console.py: timed out", file=sys.stderr)
    return 124


if __name__ == "__main__":
    sys.exit(main())
