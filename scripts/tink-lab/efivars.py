"""Read a machine's EFI boot variables from its OVMF variable store, or set its BootNext.

efivars.py VARS                      print BootOrder, BootNext and each Boot#### entry as JSON
efivars.py VARS --boot-next TARGET   set BootNext: Pxe (the first IPv4 PXE entry in BootOrder),
                                     Hdd (the first disk entry in BootOrder) or a 4-digit entry
efivars.py VARS --boot-order LIST    set BootOrder to the comma-separated 4-digit entries

It reads and writes the store with virt-fw-vars (python3 virt-firmware) from PATH, so the
machine must be off for a write.
"""

import json
import os
import struct
import subprocess
import sys
import tempfile

GLOBAL = "8be4df61-93ca-11d2-aa0d-00e098032b8c"


def load(path):
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "vars.json")
        subprocess.run(["virt-fw-vars", "-i", path, "--output-json", out], check=True, capture_output=True)
        with open(out) as f:
            return {v["name"]: v for v in json.load(f)["variables"] if v["guid"] == GLOBAL}


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
            guid = body[24:40]
            nodes.append(f"HD({part},{guid[:4][::-1].hex()}...)")
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


def write(path, name, data):
    var = {"version": 2, "variables": [{"name": name, "guid": GLOBAL, "attr": 7, "data": data.hex()}]}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(var, f)
    try:
        subprocess.run(
            ["virt-fw-vars", "--inplace", path, "--set-json", f.name], check=True, capture_output=True
        )
    finally:
        os.unlink(f.name)


def boot_order(path, order):
    entries = [n.upper() for n in order.split(",") if n]
    write(path, "BootOrder", b"".join(struct.pack("<H", int(n, 16)) for n in entries))
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
    write(path, "BootNext", struct.pack("<H", int(n, 16)))
    print(json.dumps({"BootNext": n, "entry": state["entries"].get(n)}))
    return 0


def main():
    if len(sys.argv) == 4 and sys.argv[2] == "--boot-next":
        return boot_next(sys.argv[1], sys.argv[3])
    if len(sys.argv) == 4 and sys.argv[2] == "--boot-order":
        return boot_order(sys.argv[1], sys.argv[3])
    print(json.dumps(show(sys.argv[1])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
