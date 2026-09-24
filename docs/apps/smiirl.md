---
title: Smiirl counter
description: A Go service on the folly Kubernetes cluster that replaces Smiirl's cloud, so the owner sets what the Smiirl counter shows from a web page.
status: live
---

The Smiirl counter is a split-flap display. It has five drums, and each drum has twelve flaps: the digits `0` to `9`, a blank flap and a striped flap. The `smiirl` app replaces Smiirl's cloud service and runs on the folly [Kubernetes](../platform/kubernetes.md) cluster. The counter asks the app what to show, and the owner sets that on the app's web page.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Web page and API | `https://smiirl.lolwtf.ca` or `https://counter.lolwtf.ca` | Clients that route to folly's load-balancer range. There is no sign-in. |
| Counter protocol | `http://api.smiirl.com` | The counter, through the DNS servers on [capsule](../hosts/capsule.md) and [spore](../hosts/spore.md) |

The page installs to a phone home screen and opens offline. `apps/smiirl/README.md` lists the API routes and their JSON bodies.

The counter shows one mode at a time. Times and dates are in `Canada/Atlantic`.

| Mode | The counter shows |
| --- | --- |
| `number` | A number from 0 to 99999. An optional daily step adds a fixed amount each day. After the app was down, the step applies up to 366 missed days. |
| `clock` | Hours, a striped flap, then minutes, in 24-hour or 12-hour form |
| `date` | Today's month, a striped flap, then the day |
| `days` | The number of days until or since a date |
| `countdown` | Hours and minutes until a moment, up to 99 hours and 59 minutes |
| `countup` | Hours and minutes since a moment. It stops at 99 hours and 59 minutes. |
| `github` | The public commits or pull requests of a GitHub login |
| `cycle` | Two or more modes in turn, 5 minutes each by default |

The stored number and its daily step continue while another mode shows.

## Limits

- Every change turns the drums one full revolution, even a change of one digit. To reduce wear, `tick` (1 to 60 minutes, default 1) limits `clock`, `countdown` and `countup` to one change every `tick` minutes.
- The app waits at least 10 seconds between two different values. A value sent sooner leaves the drums at a fixed offset. [Calibrate the drums](../runbooks/operate-the-smiirl-counter.md#calibrate-the-drums) corrects the offset.
- The GitHub count refreshes at most every 5 minutes from GitHub's search API, without a token. Until the first count arrives, the drums show the stored number. A failed fetch keeps the last count. No other mode needs internet access.
- The app runs one replica. Its state is `number.json` on the `smiirl-data` volume, an NFS (network file system) share from spore. If NFS on spore stops, the app's next write hangs, and from then on the page and the counter stop updating.

## How it works

The counter runs Smiirl's stock firmware and speaks plain HTTP to `api.smiirl.com`. It is on folly's `iot` network, and DHCP on `iot` gives capsule and spore as DNS servers. CoreDNS on those hosts, configured in `nix/services/coredns-sinkhole.nix`, answers `api.smiirl.com` with the address set in `clusters/folly/apps/smiirl/04-gateway.yaml`, the app's Kubernetes Gateway. It answers `smiirl.lolwtf.ca` and `counter.lolwtf.ca` with the same address, so the page loads without the WAN. Both files must name the same address, and it must be free in `LB_RANGE` in `clusters/folly/config/cluster-topology.json`.

The counter polls `GET /<mac>/number` about every 20 seconds. The app holds each poll for up to 12 seconds and answers when the value to show changes. The counter opens every connection, and the app never connects to it.

## Operate

No alerts watch the counter. [Operate the Smiirl counter](../runbooks/operate-the-smiirl-counter.md) has the checks, the repairs and the calibration procedure.

## Reference

- Source and API contract: `apps/smiirl/`
- Manifests: `clusters/folly/apps/smiirl/`
- DNS override: `nix/services/coredns-sinkhole.nix`
- Image: `ghcr.io/jonpulsifer/smiirl`
- DNS and load-balancer addresses: [Network](../platform/network.md)
