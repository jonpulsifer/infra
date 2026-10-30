"""Turn what observe ran on HookOS's serial console into JSON: the kernel command line, the
listing of /worker/fleet, and hook-docker's containers (docker ps -a in JSON lines), read from
stdin as three parts separated by ==== lines."""

import json
import sys

parts = sys.stdin.read().split("====\n")
rows = []
for line in (parts[2] if len(parts) > 2 else "").splitlines():
    try:
        rows.append(json.loads(line))
    except ValueError:
        pass
print(
    json.dumps(
        {
            "cmdline": parts[0].strip(),
            "fleet": (parts[1] if len(parts) > 1 else "").strip().splitlines(),
            "containers": [
                {k: r.get(k) for k in ("Names", "Image", "State", "Status", "CreatedAt")} for r in rows
            ],
        }
    )
)
