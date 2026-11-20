"""Read a machine's raw disk image from the host: what the installer has written, and when.

  diskstate.py show IMAGE              JSON: the GPT's partitions, each with its filesystem
                                       signature and the MiB that hold anything, and Talos's META
                                       keys (key 0x0b, the install code, shows its first 4
                                       characters only)
  diskstate.py code IMAGE              the install code in META's first copy, whole, for a test
                                       that serves the node's config under it
  diskstate.py cmdline < UKI           the command line of a UKI's first profile, its first
                                       .cmdline section
  diskstate.py fill IMAGE LABEL STEP  write a record every STEP bytes of the partition named data
  diskstate.py scan IMAGE              JSON: the MiB of the whole image that hold anything, how many
                                       lab records (sentinels and data) are left, and the first
                                       such MiB
  diskstate.py watch IMAGE STAGE TIMEOUT
                                       exit 0 when the disk gains STAGE, 124 at TIMEOUT. STAGE is
                                       gpt (a GPT header), esp (a FAT signature on the partition
                                       named EFI) or meta (Talos's META magic on the partition named
                                       META). A stage the disk holds when the watch starts counts
                                       only once it has gone and come back, as a wipe and a new
                                       install make it.

Talos's META partition holds two copies of a 256 KiB block: the magic 5a4b3c2d, then tags of a
32-bit key, a 32-bit length and the value."""

import json
import os
import struct
import sys
import time

SECTOR = 512
META_MAGIC = bytes.fromhex("5a4b3c2d")
ADV = 256 * 1024
MIB = 1 << 20


def read(fd, offset, size):
    return os.pread(fd, size, offset)


def partitions(f):
    header = read(f, SECTOR, 92)
    if header[:8] != b"EFI PART":
        return None
    lba, count, size = struct.unpack_from("<QII", header, 72)
    table = read(f, lba * SECTOR, count * size)
    parts = []
    for i in range(count):
        e = table[i * size : (i + 1) * size]
        if e[:16] == bytes(16):
            continue
        first, last = struct.unpack_from("<QQ", e, 32)
        name = e[56:128].decode("utf-16-le", "replace").rstrip("\0")
        parts.append({"name": name, "start": first, "sectors": last - first + 1})
    return parts


def fstype(f, start):
    boot = read(f, start * SECTOR, SECTOR)
    fat = b"FAT" in boot[0x36:0x3B] or b"FAT32" in boot[0x52:0x57]
    if len(boot) == SECTOR and boot[510:512] == b"\x55\xaa" and fat:
        return "vfat"
    if read(f, start * SECTOR, 4) == META_MAGIC:
        return "talos-meta"
    if read(f, start * SECTOR + 1080, 2) == b"\x53\xef":
        return "ext4"
    if read(f, start * SECTOR, 4) == b"XFSB":
        return "xfs"
    return None


def used_mib(f, start, sectors):
    zero = bytes(MIB)
    used = 0
    at, end = start * SECTOR, (start + sectors) * SECTOR
    while at < end:
        chunk = read(f, at, min(MIB, end - at))
        if not chunk:
            break
        if chunk != zero[: len(chunk)]:
            used += 1
        at += len(chunk)
    return used


def meta(f, start):
    copies = []
    for c in range(2):
        block = read(f, start * SECTOR + c * ADV, ADV)
        if block[:4] != META_MAGIC:
            copies.append(None)
            continue
        keys, at = [], 4
        while at + 8 <= len(block) - 32:
            key, length = struct.unpack_from(">II", block, at)
            if key == 0 and length == 0:
                break
            value = block[at + 8 : at + 8 + length]
            text = value.decode("ascii", "replace")
            head = text[:4] if key == 0x0B else text[:60]
            keys.append({"key": f"0x{key:02x}", "len": length, "head": head})
            at += 8 + length
        copies.append(keys)
    return copies


def code(path):
    f = os.open(path, os.O_RDONLY)
    try:
        for p in partitions(f) or []:
            if p["name"] != "META":
                continue
            block = read(f, p["start"] * SECTOR, ADV)
            at = 4
            while block[:4] == META_MAGIC and at + 8 <= len(block) - 32:
                key, length = struct.unpack_from(">II", block, at)
                if key == 0 and length == 0:
                    break
                if key == 0x0B:
                    return block[at + 8 : at + 8 + length].decode("ascii")
                at += 8 + length
    finally:
        os.close(f)
    return None


def cmdline(uki):
    pe = struct.unpack_from("<I", uki, 0x3C)[0]
    count, optional = struct.unpack_from("<H", uki, pe + 6)[0], struct.unpack_from("<H", uki, pe + 20)[0]
    table = pe + 24 + optional
    for i in range(count):
        name, size, _, _, raw = struct.unpack_from("<8sIIII", uki, table + 40 * i)
        if name.rstrip(b"\0") == b".cmdline":
            return uki[raw : raw + size].decode("ascii").rstrip("\0").strip()
    return None


def show(path):
    f = os.open(path, os.O_RDONLY)
    try:
        parts = partitions(f)
        out = {"gpt": parts is not None, "partitions": []}
        for p in parts or []:
            row = dict(p, fs=fstype(f, p["start"]), used_mib=used_mib(f, p["start"], p["sectors"]))
            if p["name"] == "META":
                row["meta"] = meta(f, p["start"])
            out["partitions"].append(row)
    finally:
        os.close(f)
    return out


def fill(path, label, step):
    f = os.open(path, os.O_RDWR)
    try:
        part = next((p for p in partitions(f) or [] if p["name"] == "data"), None)
        if part is None:
            sys.exit("no partition named data")
        start, end = part["start"] * SECTOR, (part["start"] + part["sectors"]) * SECTOR
        count = 0
        for at in range(start, end, step):
            os.pwrite(f, f"TINKLAB-DATA disk={label} offset={at}\n".encode(), at)
            count += 1
        os.fsync(f)
    finally:
        os.close(f)
    return {"partition": part, "step": step, "records": count}


def scan(path):
    zero = bytes(MIB)
    held, records, mib = [], 0, 0
    f = os.open(path, os.O_RDONLY)
    try:
        while True:
            chunk = read(f, mib * MIB, MIB)
            if not chunk:
                break
            if chunk != zero[: len(chunk)]:
                held.append(mib)
                records += chunk.count(b"TINKLAB-")
            mib += 1
    finally:
        os.close(f)
    return {"mib": mib, "held_mib": len(held), "records": records, "first_held_mib": held[:8]}


def holds(f, stage):
    parts = partitions(f)
    if stage == "gpt":
        return parts is not None
    want = {"esp": "EFI", "meta": "META"}[stage]
    for p in parts or []:
        if p["name"] == want:
            got = fstype(f, p["start"])
            return got == "vfat" if stage == "esp" else got == "talos-meta"
    return False


def watch(path, stage, timeout):
    end = time.monotonic() + timeout
    armed = False
    f = os.open(path, os.O_RDONLY)
    try:
        while time.monotonic() < end:
            now = holds(f, stage)
            if now and armed:
                return 0
            if not now:
                armed = True
            time.sleep(0.02)
    finally:
        os.close(f)
    return 124


if __name__ == "__main__":
    if sys.argv[1] == "show":
        print(json.dumps(show(sys.argv[2]), separators=(",", ":")))
    elif sys.argv[1] == "cmdline":
        c = cmdline(sys.stdin.buffer.read())
        if c is None:
            sys.exit("no .cmdline section")
        print(c)
    elif sys.argv[1] == "code":
        c = code(sys.argv[2])
        if c is None:
            sys.exit("no install code in META")
        print(c)
    elif sys.argv[1] == "fill":
        print(json.dumps(fill(sys.argv[2], sys.argv[3], int(sys.argv[4])), separators=(",", ":")))
    elif sys.argv[1] == "scan":
        print(json.dumps(scan(sys.argv[2]), separators=(",", ":")))
    elif sys.argv[1] == "watch":
        sys.exit(watch(sys.argv[2], sys.argv[3], float(sys.argv[4])))
    else:
        sys.exit("diskstate.py show IMAGE | code IMAGE | cmdline < UKI | fill IMAGE LABEL STEP | scan IMAGE"
                 " | watch IMAGE gpt|esp|meta TIMEOUT")
