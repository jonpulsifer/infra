---
title: Switchboard board
description: A read-only web page of the folly PBX's calls in progress, their IVR stage, the four office-phone lines and the calls that ended since the pod started.
status: live
---

The Switchboard board is a web page of the office phone as the folly [PBX](../pbx.md) sees it, and the `board` role of the [Switchboard](../switchboard.md) image. The owner reads it to see who is calling, what the PBX does with them, and whether each line works.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Page | `https://switchboard.lolwtf.ca` | Clients that route to folly's load-balancer range, with no sign-in |
| Snapshot as JSON | `/api/board` on the same host | The same clients |
| Server-Sent Events | `/events` on the same host | The same clients |

The page shows:

- Each call in progress: the caller, or the number the handset dialled; the line and trunk; the IVR stage, such as `press-5 prompt`, `with Earl` or `held: Robo-Lenny`; the verdict and `pbx-event` kinds; and the elapsed time.
- Each line: handset and trunk registration, whether it screens, and whether a call is up.
- The last 25 calls to end, with the hangup cause, and the state of the ARI connection.

## Limits

- The page has no sign-in and shows callers' names and numbers to every client that reaches it.
- The pod holds the recent calls, so a restart empties the list.
- A context the board has no name for reads as `in <context>`.

## How it works

The board connects to ARI, the Asterisk REST interface, on the PBX's HTTP port as the read-only user in `clusters/folly/apps/pbx/config/ari.conf`; `pbx-check` fails a config with a writable ARI user. One websocket subscribes to every event. The board reads the channel list at each connect and each minute, and `/metrics` every 15 seconds for trunk registrations.

It reads the lines from the `pjsip.conf` template in the `pbx-site` ConfigMap, each stage from the dialplan position, and each verdict from the `pbx-event` kinds in `config/events.conf`. The PBX does not load `res_ari_asterisk`, which returns trunk passwords to any ARI user. CiliumNetworkPolicies admit only the Gateway and the kubelet to the board, and the board to the PBX.

## Operate

No alert watches the board. The ARI password is the SOPS Secret `pbx-ari`, which the PBX reads when its pod starts. If the page shows `ARI disconnected (unauthorized)`, restart the `pbx` Deployment when no call is up. To rotate the password, run this from the repo root, merge, and restart `pbx`:

```sh
SOPS_AGE_KEY_FILE=~/.config/age/keys.txt bash -c 'set -euo pipefail
f=clusters/folly/apps/pbx/ari-secret.sops.yaml
pw=$(head -c 24 /dev/urandom | od -An -vtx1 | tr -d " \n")
printf "apiVersion: v1\nkind: Secret\nmetadata:\n  name: pbx-ari\n  namespace: pbx\ntype: Opaque\nstringData:\n  PBX_ARI_PASSWORD: \"%s\"\n" "$pw" |
  sops encrypt --filename-override "$f" /dev/stdin >"$f"'
```

## Reference

- Source: `apps/switchboard/src/board/`
- Manifests: `clusters/folly/apps/pbx/switchboard.yaml`
- ARI user: `clusters/folly/apps/pbx/config/ari.conf`
- Image: `ghcr.io/jonpulsifer/switchboard`
