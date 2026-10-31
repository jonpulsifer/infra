"""A stand-in for the NetBox API that fleetd's reconcile pass reads and writes.

Usage: netbox.py PORT STATE_DIR

STATE_DIR/devices.json holds the devices and their interfaces, as tink-lab.sh writes them:
{"devices": [<a NetBox device>...], "interfaces": [<a NetBox interface>...]}. The server serves
GET /api/dcim/devices/ (filters: role, status, serial, cf_smbios_uuid, name), GET
/api/dcim/interfaces/ (device_id), PATCH /api/dcim/devices/ID/ and POST
/api/extras/journal-entries/, which is what apps/fleetd/fleet/netbox.go calls. A role=switch
query answers no switches.

The harness's own calls, under /lab/:
  PATCH /lab/devices/NAME   an owner's edit: {"status": S, "custom_fields": {...}}
  PUT   /lab/fail-patch     {"on": true} makes every fleetd device PATCH answer 500

Every PATCH and journal entry from fleetd is appended to STATE_DIR/writes.jsonl, with a time.
"""

import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, state = int(sys.argv[1]), sys.argv[2]
lock = threading.Lock()
fail_patch = False


def load():
    with open(os.path.join(state, "devices.json")) as f:
        return json.load(f)


def save(db):
    tmp = os.path.join(state, "devices.json.tmp")
    with open(tmp, "w") as f:
        json.dump(db, f, indent=1)
    os.replace(tmp, os.path.join(state, "devices.json"))


def record(kind, **kv):
    now = time.time()
    line = {"time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now % 1 * 1000):03d}Z", "kind": kind}
    line.update(kv)
    with open(os.path.join(state, "writes.jsonl"), "a") as f:
        f.write(json.dumps(line) + "\n")


def merge(dev, patch):
    for k, v in patch.items():
        if k == "custom_fields":
            dev["custom_fields"].update(v)
        elif k == "status":
            dev["status"] = {"value": v, "label": v.capitalize()}
        else:
            dev[k] = v


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body=None):
        raw = json.dumps(body if body is not None else {}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        with lock:
            db = load()
        if u.path == "/api/dcim/devices/":
            if q.get("role") == ["switch"]:
                return self.reply(200, {"count": 0, "next": None, "results": []})
            out = []
            for d in db["devices"]:
                if "status" in q and d["status"]["value"] not in q["status"]:
                    continue
                if "serial" in q and d["serial"] not in q["serial"]:
                    continue
                if "name" in q and d["name"] not in q["name"]:
                    continue
                if "cf_smbios_uuid" in q and d["custom_fields"].get("smbios_uuid") not in q["cf_smbios_uuid"]:
                    continue
                out.append(d)
            return self.reply(200, {"count": len(out), "next": None, "results": out})
        if u.path == "/api/dcim/interfaces/":
            ids = q.get("device_id", [])
            out = [i for i in db["interfaces"] if not ids or str(i["device"]["id"]) in ids]
            return self.reply(200, {"count": len(out), "next": None, "results": out})
        return self.reply(404, {"detail": "not found"})

    def do_PATCH(self):
        global fail_patch
        p = self.body()
        with lock:
            db = load()
            if self.path.startswith("/lab/devices/"):
                name = self.path.rstrip("/").rsplit("/", 1)[1]
                devs = [d for d in db["devices"] if d["name"] == name]
                if not devs:
                    return self.reply(404, {"detail": "no device"})
                merge(devs[0], p)
                save(db)
                record("owner", device=name, patch=p)
                return self.reply(200, devs[0])
            parts = self.path.strip("/").split("/")
            if parts[:3] == ["api", "dcim", "devices"] and len(parts) == 4:
                devs = [d for d in db["devices"] if str(d["id"]) == parts[3]]
                if not devs:
                    return self.reply(404, {"detail": "no device"})
                if fail_patch:
                    record("patch-refused", device=devs[0]["name"], patch=p)
                    return self.reply(500, {"detail": "tink-lab: fail-patch is on"})
                merge(devs[0], p)
                save(db)
                record("patch", device=devs[0]["name"], patch=p)
                return self.reply(200, devs[0])
        return self.reply(404, {"detail": "not found"})

    def do_PUT(self):
        global fail_patch
        if self.path == "/lab/fail-patch":
            fail_patch = bool(self.body().get("on"))
            return self.reply(200, {"fail_patch": fail_patch})
        return self.reply(404, {"detail": "not found"})

    def do_POST(self):
        if self.path == "/api/extras/journal-entries/":
            p = self.body()
            with lock:
                names = [d["name"] for d in load()["devices"] if d["id"] == p.get("assigned_object_id")]
                record("journal", device=names[0] if names else None, level=p.get("kind"), comments=p.get("comments"))
            return self.reply(201, p)
        return self.reply(404, {"detail": "not found"})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S", time.gmtime()), fmt % args))


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
