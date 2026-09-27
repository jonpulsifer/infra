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
- The last 25 calls to end, and the state of the ARI connection.

## Limits

- The page has no sign-in and shows callers' names and numbers to every client that reaches it.
- The board samples the PBX once a second, so a call that ends within a second, such as one the screening cap refuses, can miss the page. The PBX log still has it.
- The recent calls carry no hangup cause, and the pod holds them, so a restart empties the list.
- A context the board has no name for reads as `in <context>`.

## How it works

The board polls ARI, the Asterisk REST interface, on the PBX's HTTP port as the user in `clusters/folly/apps/pbx/config/ari.conf`. Each second it reads the channel, bridge and endpoint lists, and every 15 seconds `/metrics` for trunk registrations. Each channel carries the variables `ari.conf` names, so the board reads the stage from the dialplan position and the verdict from `TRAIL`, which `config/events.conf` appends each `pbx-event` kind to.

ARI's read-only user can still run dialplan functions through a GET, so the CiliumNetworkPolicy `pbx-ari` admits the board to those four paths alone, by exact path and as GET. The PBX refuses the modules in `clusters/base/apps/pbx/config/modules.conf` that would hand the ARI password more, and `pbx-check` fails a writable ARI user.

## Operate

No alert watches the board. [Operate the office phone](../../runbooks/operate-the-office-phone.md#rotate-the-boards-ari-password) rotates its ARI password and says what `ARI disconnected (unauthorized)` means.

## Reference

- Source: `apps/switchboard/src/board/`
- Manifests: `clusters/folly/apps/pbx/switchboard.yaml`
- ARI user: `clusters/folly/apps/pbx/config/ari.conf`
- Image: `ghcr.io/jonpulsifer/switchboard`
