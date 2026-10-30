"""A Redfish BMC for one tink-lab machine, enough of the protocol for Rufio's gofish provider.

bmc.py NAME PORT CERT KEY VMDIR

The BMC owns the machine's power: PowerState is On while the machine's QEMU process lives. On runs
`tink-lab.sh _qemu NAME`, which execs QEMU; ForceOff and PowerCycle kill it, and GracefulShutdown
asks the guest through ACPI on the QMP socket in TINK_LAB_QMP. A one-time boot override (PATCH Boot
with Pxe or Hdd, Once) runs `tink-lab.sh _bootnext NAME TARGET`, which sets BootNext in the stopped
machine's EFI variables just before the next On, as a real BMC's one-time boot sets the firmware's
next boot. VMDIR/boot.json keeps a pending override across BMC restarts and VMDIR/qemu.pid the
QEMU process. Every request is logged as one JSON line on stdout.
"""

import base64
import json
import os
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USER, PASSWORD = "tink-lab", "tink-lab"
NAME, PORT, CERT, KEY, VMDIR = sys.argv[1:6]
LAB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tink-lab.sh")
STATE = os.path.join(VMDIR, "boot.json")
PIDFILE = os.path.join(VMDIR, "qemu.pid")
SYSTEM = f"/redfish/v1/Systems/{NAME}"
lock = threading.Lock()
qemu = None
sessions = set()


def log(**kw):
    print(
        json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "bmc": NAME, **kw}),
        flush=True,
    )


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"target": "None", "enabled": "Disabled", "mode": "UEFI"}


def save(boot):
    with open(STATE + ".new", "w") as f:
        json.dump(boot, f)
    os.replace(STATE + ".new", STATE)


def running():
    global qemu
    if qemu is not None and qemu.poll() is None:
        return True
    qemu = None
    # A QEMU this BMC did not start (a restarted BMC) still counts as on.
    try:
        with open(PIDFILE) as f:
            pid = int(f.read())
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return b"qemu-system" in f.read()
    except (OSError, ValueError):
        return False


def pid():
    if qemu is not None:
        return qemu.pid
    with open(PIDFILE) as f:
        return int(f.read())


def power_on():
    global qemu
    if running():
        return
    boot = load()
    if boot["enabled"] in ("Once", "Continuous") and boot["target"] in ("Pxe", "Hdd"):
        r = subprocess.run([LAB, "_bootnext", NAME, boot["target"]], capture_output=True, text=True)
        log(
            event="boot-override",
            target=boot["target"],
            status=r.returncode,
            out=(r.stdout + r.stderr).strip(),
        )
        if boot["enabled"] == "Once":
            boot.update(target="None", enabled="Disabled")
            save(boot)
    qemu = subprocess.Popen([LAB, "_qemu", NAME], start_new_session=True)
    with open(PIDFILE, "w") as f:
        f.write(str(qemu.pid))
    log(event="power", state="On", pid=qemu.pid)


def power_off(force=True):
    if not running():
        return
    if force:
        os.kill(pid(), signal.SIGKILL)
        if qemu is not None:
            qemu.wait()
        log(event="power", state="Off", how="ForceOff")
        return
    try:
        s = socket.socket(socket.AF_UNIX)
        s.connect(os.environ["TINK_LAB_QMP"])
        s.sendall(b'{"execute":"qmp_capabilities"}\n{"execute":"system_powerdown"}\n')
        time.sleep(0.2)
        s.close()
        log(event="power", state="ShuttingDown", how="GracefulShutdown")
    except (OSError, KeyError) as e:
        log(event="power", error=f"ACPI powerdown: {e}")


def system():
    boot = load()
    return {
        "@odata.id": SYSTEM,
        "@odata.type": "#ComputerSystem.v1_20_0.ComputerSystem",
        "Id": NAME,
        "Name": NAME,
        "SystemType": "Virtual",
        "Manufacturer": "QEMU",
        "Model": "tink-lab",
        "PowerState": "On" if running() else "Off",
        "Status": {"State": "Enabled", "Health": "OK"},
        "Boot": {
            "BootSourceOverrideEnabled": boot["enabled"],
            "BootSourceOverrideTarget": boot["target"],
            "BootSourceOverrideMode": boot["mode"],
            "BootSourceOverrideTarget@Redfish.AllowableValues": ["None", "Pxe", "Hdd"],
        },
        "Actions": {
            "#ComputerSystem.Reset": {
                "target": SYSTEM + "/Actions/ComputerSystem.Reset",
                "ResetType@Redfish.AllowableValues": [
                    "On",
                    "ForceOn",
                    "ForceOff",
                    "GracefulShutdown",
                    "GracefulRestart",
                    "ForceRestart",
                    "PowerCycle",
                ],
            }
        },
        "Links": {"ManagedBy": [{"@odata.id": "/redfish/v1/Managers/bmc"}]},
    }


ROOT = {
    "@odata.id": "/redfish/v1/",
    "@odata.type": "#ServiceRoot.v1_15_0.ServiceRoot",
    "Id": "RootService",
    "Name": "tink-lab BMC",
    "RedfishVersion": "1.15.0",
    "UUID": "00000000-0000-0000-0000-000000000000",
    "Systems": {"@odata.id": "/redfish/v1/Systems"},
    "Managers": {"@odata.id": "/redfish/v1/Managers"},
    "SessionService": {"@odata.id": "/redfish/v1/SessionService"},
    "Links": {"Sessions": {"@odata.id": "/redfish/v1/SessionService/Sessions"}},
}


def collection(path, kind, members):
    return {
        "@odata.id": path,
        "@odata.type": f"#{kind}Collection.{kind}Collection",
        "Name": f"{kind} Collection",
        "Members": [{"@odata.id": m} for m in members],
        "Members@odata.count": len(members),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("OData-Version", "4.0")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)
        log(method=self.command, path=self.path, status=status)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def authed(self):
        if self.headers.get("X-Auth-Token") in sessions:
            return True
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            return base64.b64decode(auth[6:]).decode() == f"{USER}:{PASSWORD}"
        return False

    def route(self):
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path in ("/redfish", "/redfish/v1"):
            return path
        if not self.authed():
            self.reply(401, {"error": {"message": "unauthorized"}})
            return None
        return path

    def do_GET(self):
        path = self.route()
        if path is None:
            return
        with lock:
            if path == "/redfish":
                return self.reply(200, {"v1": "/redfish/v1/"})
            if path == "/redfish/v1":
                return self.reply(200, ROOT)
            if path == "/redfish/v1/Systems":
                return self.reply(200, collection(path, "ComputerSystem", [SYSTEM]))
            if path == SYSTEM:
                return self.reply(200, system())
            if path == "/redfish/v1/Managers":
                return self.reply(200, collection(path, "Manager", ["/redfish/v1/Managers/bmc"]))
            if path == "/redfish/v1/Managers/bmc":
                return self.reply(
                    200,
                    {
                        "@odata.id": path,
                        "@odata.type": "#Manager.v1_10_0.Manager",
                        "Id": "bmc",
                        "Name": "tink-lab BMC",
                        "ManagerType": "BMC",
                        "Links": {"ManagerForServers": [{"@odata.id": SYSTEM}]},
                    },
                )
            if path == "/redfish/v1/SessionService":
                return self.reply(
                    200,
                    {
                        "@odata.id": path,
                        "@odata.type": "#SessionService.v1_1_8.SessionService",
                        "Id": "SessionService",
                        "Name": "Sessions",
                        "ServiceEnabled": True,
                        "Sessions": {"@odata.id": path + "/Sessions"},
                    },
                )
            if path == "/redfish/v1/SessionService/Sessions":
                return self.reply(200, collection(path, "Session", []))
        self.reply(404, {"error": {"message": f"no {path}"}})

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if path == "/redfish/v1/SessionService/Sessions":
            b = self.body()
            if b.get("UserName") != USER or b.get("Password") != PASSWORD:
                return self.reply(401, {"error": {"message": "bad credentials"}})
            token = secrets.token_hex(16)
            sessions.add(token)
            sid = f"{path}/{token[:8]}"
            return self.reply(
                201,
                {"@odata.id": sid, "Id": token[:8], "UserName": USER},
                {"X-Auth-Token": token, "Location": sid},
            )
        if self.route() is None:
            return
        if path == SYSTEM + "/Actions/ComputerSystem.Reset":
            kind = self.body().get("ResetType", "")
            log(event="reset", type=kind)
            with lock:
                if kind in ("On", "ForceOn"):
                    power_on()
                elif kind == "ForceOff":
                    power_off()
                elif kind == "GracefulShutdown":
                    power_off(force=False)
                elif kind in ("ForceRestart", "GracefulRestart", "PowerCycle"):
                    power_off()
                    power_on()
                else:
                    return self.reply(400, {"error": {"message": f"ResetType {kind!r}"}})
            return self.reply(204)
        self.reply(404, {"error": {"message": f"no {path}"}})

    def do_PATCH(self):
        path = self.route()
        if path is None:
            return
        if path != SYSTEM:
            return self.reply(404, {"error": {"message": f"no {path}"}})
        b = self.body().get("Boot", {})
        with lock:
            boot = load()
            boot["target"] = b.get("BootSourceOverrideTarget", boot["target"])
            boot["enabled"] = b.get("BootSourceOverrideEnabled", boot["enabled"])
            boot["mode"] = b.get("BootSourceOverrideMode", boot["mode"])
            if boot["target"] not in ("None", "Pxe", "Hdd"):
                return self.reply(400, {"error": {"message": f"target {boot['target']!r}"}})
            save(boot)
            log(event="boot-set", **boot)
            return self.reply(200, system())

    def do_DELETE(self):
        path = self.path.rstrip("/")
        token = self.headers.get("X-Auth-Token")
        if path.startswith("/redfish/v1/SessionService/Sessions/") and token in sessions:
            sessions.discard(token)
            return self.reply(204)
        self.reply(404, {"error": {"message": f"no {path}"}})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", int(PORT)), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    log(event="listening", port=int(PORT), power="On" if running() else "Off")
    server.serve_forever()


if __name__ == "__main__":
    main()
