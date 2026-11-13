"""Read a machine's EFI boot variables from its OVMF variable store, or set its BootNext.

efivars.py VARS                      print BootOrder, BootNext and each Boot#### entry as JSON
efivars.py VARS --boot-next TARGET   set BootNext: Pxe (the first IPv4 PXE entry in BootOrder),
                                     Hdd (the first disk entry in BootOrder) or a 4-digit entry
efivars.py VARS --boot-order LIST    set BootOrder to the comma-separated 4-digit entries
efivars.py VARS --entry N DESC PARTUUID FILE
                                     write Boot#### N: DESC, booting FILE from partition 1 of the
                                     GPT disk whose partition 1 has PARTUUID, as an installer's
                                     entry does (it need not exist: a stale entry)
efivars.py VARS --delete N           delete Boot#### N; BootOrder keeps it, as after an OS removes one
efivars.py VARS --fill FREE          add TinkLabFill#### variables until fewer than FREE bytes of the
                                     store are left, so the firmware boots but an OS write fails
efivars.py VARS --unfill             delete every TinkLabFill#### variable

It reads and writes the store with virt-fw-vars (python3 virt-firmware) from PATH, so the
machine must be off for a write.
"""

import json
import os
import struct
import subprocess
import sys
import tempfile
import uuid

GLOBAL = "8be4df61-93ca-11d2-aa0d-00e098032b8c"
# A vendor GUID of tink-lab's own for the filler variables.
FILL_GUID = "7e1ab0f1-0000-4000-8000-000000000009"


def load(path, guid=GLOBAL):
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "vars.json")
        subprocess.run(["virt-fw-vars", "-i", path, "--output-json", out], check=True, capture_output=True)
        with open(out) as f:
            return {v["name"]: v for v in json.load(f)["variables"] if v["guid"] == guid}


def device_path(data):
    """Decode the device path nodes that matter here into short text and a kind."""
    nodes, kinds, i = [], set(), 0
    while i + 4 <= len(data):
        t, sub, n = data[i], data[i + 1], struct.unpack_from("<H", data, i + 2)[0]
        if n < 4:
            break
        body = data[i + 4 : i + n]
        if t == 0x7F:
            break
        if t == 1 and sub == 1:
            nodes.append(f"Pci(0x{body[1]:x},0x{body[0]:x})")
        elif t == 2 and sub == 1:
            nodes.append("PciRoot")
        elif t == 3 and sub == 11:
            nodes.append("MAC(" + body[:6].hex() + ")")
        elif t == 3 and sub == 12:
            nodes.append("IPv4")
            kinds.add("ipv4")
        elif t == 3 and sub == 13:
            nodes.append("IPv6")
            kinds.add("ipv6")
        elif t == 3 and sub == 24:
            nodes.append("Uri(" + body.decode(errors="replace") + ")")
            kinds.add("uri")
        elif t == 3 and sub == 5:
            nodes.append("USB")
            kinds.add("usb")
        elif t == 3 and sub == 18:
            nodes.append(f"Sata({struct.unpack_from('<H', body)[0]})")
            kinds.add("disk")
        elif t == 3 and sub == 23:
            nodes.append(f"NVMe({struct.unpack_from('<I', body)[0]})")
            kinds.add("disk")
        elif t == 4 and sub == 1:
            part = struct.unpack_from("<I", body)[0]
            nodes.append(f"HD({part},{uuid.UUID(bytes_le=body[20:36])})")
            kinds.add("disk")
        elif t == 4 and sub == 4:
            nodes.append("File(" + body.decode("utf-16-le", errors="replace").rstrip("\0") + ")")
        elif t == 4 and sub in (6, 7):
            nodes.append("FvFile" if sub == 6 else "Fv")
            kinds.add("firmware")
        else:
            nodes.append(f"Node({t},{sub})")
        i += n
    if "uri" in kinds:
        kind = "http"
    elif "ipv4" in kinds:
        kind = "pxe-ipv4"
    elif "ipv6" in kinds:
        kind = "pxe-ipv6"
    elif "firmware" in kinds:
        kind = "firmware"
    elif "disk" in kinds or any(x.startswith("Pci") for x in nodes):
        kind = "disk"
    else:
        kind = "other"
    return "/".join(nodes), kind


def entry(data):
    attrs, plen = struct.unpack_from("<IH", data)
    end = 6
    while data[end : end + 2] != b"\0\0":
        end += 2
    desc = data[6:end].decode("utf-16-le", errors="replace")
    path, kind = device_path(data[end + 2 : end + 2 + plen])
    return {"description": desc, "active": bool(attrs & 1), "kind": kind, "path": path}


def u16s(var):
    data = bytes.fromhex(var["data"]) if var else b""
    return [f"{x:04X}" for x in struct.unpack(f"<{len(data) // 2}H", data)]


def show(path):
    v = load(path)
    entries = {
        k[4:]: entry(bytes.fromhex(x["data"]))
        for k, x in sorted(v.items())
        if k.startswith("Boot") and len(k) == 8 and all(c in "0123456789ABCDEF" for c in k[4:])
    }
    nxt = u16s(v.get("BootNext"))
    return {"BootOrder": u16s(v.get("BootOrder")), "BootNext": nxt[0] if nxt else None, "entries": entries}


def write(path, name, data, guid=GLOBAL):
    """Write one variable; False when the store has no room for it."""
    var = {"version": 2, "variables": [{"name": name, "guid": guid, "attr": 7, "data": data.hex()}]}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(var, f)
    try:
        r = subprocess.run(["virt-fw-vars", "--inplace", path, "--set-json", f.name], capture_output=True, text=True)
    finally:
        os.unlink(f.name)
    if r.returncode != 0:
        if "too small" in r.stderr:
            return False
        raise RuntimeError(r.stderr.strip())
    return True


def delete(path, name):
    subprocess.run(["virt-fw-vars", "--inplace", path, "--delete", name], check=True, capture_output=True)


def ucs2(text):
    return (text + "\0").encode("utf-16-le")


def set_entry(path, n, desc, partuuid, file):
    """A Boot#### of the installer's shape: HD(1,GPT,PARTUUID,0x800,0x41a800)/File(FILE)."""
    hd = struct.pack("<IQQ", 1, 0x800, 0x41A800) + uuid.UUID(partuuid).bytes_le + bytes([2, 2])
    fp = ucs2(file)
    path_ = (
        struct.pack("<BBH", 4, 1, 4 + len(hd)) + hd + struct.pack("<BBH", 4, 4, 4 + len(fp)) + fp + bytes([0x7F, 0xFF, 4, 0])
    )
    data = struct.pack("<IH", 1, len(path_)) + ucs2(desc) + path_
    if not write(path, f"Boot{n.upper()}", data):
        print(json.dumps({"error": "the variable store is full"}))
        return 1
    print(json.dumps({"entry": n.upper(), "value": entry(data)}))
    return 0


def fill(path, free):
    """Fill the store with TinkLabFill#### variables, largest first, until under FREE bytes are left."""
    have = load(path, FILL_GUID)
    i = len(have)
    for size in (16384, 4096, 1024, 256, 64):
        while True:
            # A size that still fits leaves room only when free plus its own size fits as well.
            if not write(path, "TinkLabProbe", b"\xff" * (free + size), FILL_GUID):
                break
            delete(path, "TinkLabProbe")
            if not write(path, f"TinkLabFill{i:04X}", b"\xa5" * size, FILL_GUID):
                break
            i += 1
    print(json.dumps({"filled": i, "free_under": free}))
    return 0


def unfill(path):
    names = list(load(path, FILL_GUID))
    for name in names:
        delete(path, name)
    print(json.dumps({"deleted": len(names)}))
    return 0


def boot_order(path, order):
    entries = [n.upper() for n in order.split(",") if n]
    if not write(path, "BootOrder", b"".join(struct.pack("<H", int(n, 16)) for n in entries)):
        print(json.dumps({"error": "the variable store is full"}))
        return 1
    print(json.dumps({"BootOrder": entries}))
    return 0


def boot_next(path, target):
    state = show(path)
    order = state["BootOrder"] + [k for k in state["entries"] if k not in state["BootOrder"]]
    if target in ("Pxe", "Hdd"):
        want = "pxe-ipv4" if target == "Pxe" else "disk"
        pick = [n for n in order if n in state["entries"] and state["entries"][n]["kind"] == want]
        if not pick:
            print(json.dumps({"error": f"no {want} entry", "BootOrder": state["BootOrder"]}))
            return 1
        n = pick[0]
    else:
        n = target.upper()
    if not write(path, "BootNext", struct.pack("<H", int(n, 16))):
        print(json.dumps({"error": "the variable store is full"}))
        return 1
    print(json.dumps({"BootNext": n, "entry": state["entries"].get(n)}))
    return 0


def main():
    if len(sys.argv) == 4 and sys.argv[2] == "--boot-next":
        return boot_next(sys.argv[1], sys.argv[3])
    if len(sys.argv) == 4 and sys.argv[2] == "--boot-order":
        return boot_order(sys.argv[1], sys.argv[3])
    if len(sys.argv) == 7 and sys.argv[2] == "--entry":
        return set_entry(sys.argv[1], *sys.argv[3:7])
    if len(sys.argv) == 4 and sys.argv[2] == "--delete":
        delete(sys.argv[1], f"Boot{sys.argv[3].upper()}")
        print(json.dumps({"deleted": sys.argv[3].upper()}))
        return 0
    if len(sys.argv) == 4 and sys.argv[2] == "--fill":
        return fill(sys.argv[1], int(sys.argv[3]))
    if len(sys.argv) == 3 and sys.argv[2] == "--unfill":
        return unfill(sys.argv[1])
    print(json.dumps(show(sys.argv[1])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
