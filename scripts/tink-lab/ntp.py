"""An SNTP server on the boot server's address, standing in for spore's chrony.

ntp.py ADDRESS answers each NTP client request on ADDRESS:123 with this host's clock, as a
stratum 2 server. Talos waits for a time sync before it fetches its config.
"""

import socket
import struct
import sys
import time

EPOCH = 2208988800  # seconds from 1900 to 1970


def stamp(t):
    return struct.pack("!II", int(t) + EPOCH, int((t % 1) * 2**32))


def main():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((sys.argv[1], 123))
    while True:
        data, peer = s.recvfrom(512)
        received = time.time()
        if len(data) < 48 or data[0] & 0x7 != 3:
            continue
        version = (data[0] >> 3) & 0x7
        reply = bytes([(version << 3) | 4, 2, data[2], 0xEC])
        reply += struct.pack("!II", 0, 1 << 10) + b"LOCL"
        reply += stamp(received - 1) + data[40:48] + stamp(received) + stamp(time.time())
        s.sendto(reply, peer)


if __name__ == "__main__":
    main()
