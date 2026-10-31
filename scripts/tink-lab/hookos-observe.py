"""Turn what observe ran on HookOS's serial console into JSON: the kernel command line, the
listing of /worker/fleet, hook-docker's containers (docker ps -a in JSON lines), the kernel's block
devices (one line each of key=value fields after the name) and the /dev/disk/by-id names, read
from stdin as five parts separated by ==== lines."""

import json
import sys

parts = sys.stdin.read().split("====\n")
rows = []
for line in (parts[2] if len(parts) > 2 else "").splitlines():
    try:
        rows.append(json.loads(line))
    except ValueError:
        pass
blocks = []
for line in (parts[3] if len(parts) > 3 else "").splitlines():
    name, _, rest = line.strip().partition(" ")
    if not name or "=" not in rest:
        continue
    row = {"name": name}
    for field in rest.split():
        k, _, v = field.partition("=")
        row[k] = v
    blocks.append(row)
print(
    json.dumps(
        {
            "cmdline": parts[0].strip(),
            "fleet": (parts[1] if len(parts) > 1 else "").strip().splitlines(),
            "containers": [
                {k: r.get(k) for k in ("Names", "Image", "State", "Status", "CreatedAt")} for r in rows
            ],
            "blocks": blocks,
            "by_id": (parts[4] if len(parts) > 4 else "").split(),
        }
    )
)
