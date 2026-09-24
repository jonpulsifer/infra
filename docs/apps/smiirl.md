---
title: Smiirl counter
description: A Go service on the folly Kubernetes cluster that replaces Smiirl's cloud, so the owner sets what the Smiirl counter shows from a web page.
status: live
---

The Smiirl counter is a split-flap display with five drums. Each drum has twelve flaps: the digits `0` to `9`, a blank and stripes. The `smiirl` app on the folly [Kubernetes](../platform/kubernetes.md) cluster replaces Smiirl's cloud. The owner sets what the counter shows on the app's web page.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Web page and API | `https://smiirl.lolwtf.ca` or `https://counter.lolwtf.ca` | Clients that route to folly's load-balancer range, with no sign-in |
| Counter protocol | `http://api.smiirl.com` | The counter, through the DNS servers on [capsule](../hosts/capsule.md) and [spore](../hosts/spore.md) |

The counter shows one mode at a time, in `Canada/Atlantic` time.

| Mode | The counter shows |
| --- | --- |
| `number` | A number from 0 to 99999, with an optional daily step that also runs in other modes. After downtime, it catches up to 366 missed days. |
| `clock` | Hours, stripes, minutes, in 24-hour or 12-hour form |
| `date` | Month, stripes, day |
| `days` | Days until or since a date |
| `countdown`, `countup` | Hours and minutes until or since a moment, up to 99:59 |
| `github` | Public commits or pull requests of a GitHub login |
| `robocalls` | Calls the folly [PBX](pbx.md) screened today, from VictoriaLogs |
| `cycle` | Two or more modes in turn, 5 minutes each by default |

## Limits

- Every change turns the drums one full revolution. `tick` (1 to 60 minutes, default 1) limits `clock`, `countdown` and `countup` to one change every `tick` minutes.
- The app waits at least 10 seconds between values. A value sent sooner leaves the drums offset. [Calibrate the drums](../runbooks/operate-the-smiirl-counter.md#calibrate-the-drums) corrects it.
- The GitHub count refreshes at most every 5 minutes, without a token. `robocalls` refreshes at most every minute, in-cluster only. No mode needs internet access beyond GitHub's.
- The app state is `number.json` on the `smiirl-data` NFS share from spore. If NFS on spore stops, the page and the counter stop updating.

## How it works

The counter runs Smiirl's stock firmware and polls `GET /<mac>/number` on `api.smiirl.com` over plain HTTP about every 20 seconds. The app holds each poll for up to 12 seconds and answers when the value changes.

The counter is on folly's `iot` network, where DHCP gives capsule and spore as DNS servers. CoreDNS on those hosts answers `api.smiirl.com`, `smiirl.lolwtf.ca` and `counter.lolwtf.ca` with the address of the app's Gateway. `nix/services/coredns-sinkhole.nix` and `clusters/folly/apps/smiirl/04-gateway.yaml` must name the same address, and it must be free in `LB_RANGE` in `clusters/folly/config/cluster-topology.json`.

`robocalls` counts, with a LogsQL query in `apps/smiirl/vlogs.go`, the lines VictoriaLogs holds for `namespace="pbx"`, `container="asterisk"` whose message contains `pbx-event kind=screened` since midnight in `TZ`. It reads `victoria-logs-server.monitoring.svc.cluster.local:9428` directly, in the same cluster, with no [Gateway route](../platform/observability.md) exposing it further.

## Operate

No alerts watch the counter. See [Operate the Smiirl counter](../runbooks/operate-the-smiirl-counter.md).

## Reference

- Source and API contract: `apps/smiirl/`
- Manifests: `clusters/folly/apps/smiirl/`
- Image: `ghcr.io/jonpulsifer/smiirl`
