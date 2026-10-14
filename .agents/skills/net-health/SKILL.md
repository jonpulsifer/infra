---
name: net-health
description: >-
  Answer "was the internet bad at folly today" from the records the house
  keeps: the Starlink dish's own event log, the gateway's WAN monitor, and one
  client's five-minute Wi-Fi series. Use when someone reports a bad-internet
  day, a flaky video call or slow Wi-Fi at folly, and to refresh the
  net.kthx.dev report page.
---

# Net health

`.agents/skills/net-health/net-health.sh` reads three records and prints
compact tables in Atlantic time. Run `summary` first; `help` lists the rest.
It only reads. It leans on `.agents/skills/unifi-network/unifi.sh` for the
controller login, so set `UNIFI_HOST` and `UNIFI_SSH_HOST` as the
`unifi-network` skill says, and have `OP_SERVICE_ACCOUNT_TOKEN` set.

## What each command reads

- `dish`: the Starlink dish at `192.168.100.1:9200` over gRPC, with `grpcurl`
  from `mise.toml`. It is reachable from the lab LAN, including WSL on tallboy.
  The `eventLog` carries every drop since the dish booted with a cause and a
  length; `OUTAGE_NO_PINGS` under a second is background, and
  `HIGH_DOWNLINK_PACKET_LOSS` runs of 5 s or more are what a call feels. A
  normal day logs 3 to 12 events; 45 with a dozen loss runs is a bad one.
  The per-second ring buffers hold only the last 15 minutes, and the dish's
  `outages` array is on another timebase, so the script ignores both.
- `wan`: the gateway's 24-hour monitor availability from `stat/health`, the
  `wan-failover` lines in the gateway journal (it logs a monitor only when it
  loses packets; `wgsts1000` release and control pairs are the site-to-site
  WireGuard to offsite flapping), and the WAN bytes per hour.
- `client <term>`: the client's `5minutes.user` report. `rx_bytes` is upload
  from the client and `tx_bytes` is download to it. A healthy link holds
  satisfaction above 95 and retries under 15%. Client events come from the
  controller's system log at `/v2/api/site/default/system-log/all`; UniFi
  Network 10 answers `NotFound` to the legacy `stat/event` and `stat/alarm`.

`NET_DAY=yesterday` or `NET_DAY=2026-10-12` moves the day. A day that is not
over ends at now.

## The report page

`site/index.html` renders `data.js` as the page at <https://net.kthx.dev>, a
kthx quick site the owner's workstation token claimed on 2026-10-13. Refresh it
with `site`, then deploy; the site's `kthx.json` stays outside this repository.

```bash
.agents/skills/net-health/net-health.sh site Constances-MBP ~/sites/net
KTHX_ORIGIN=https://kthx.lolwtf.ca kthx deploy ~/sites/net
```

The page is written for the person whose day it was, so it names the client
by its first name, and `data.js` carries only link quality and traffic volume,
never what was visited.

## Known clients

Constance's MacBook joins the `fml` WLAN with the private MAC
`1e:b2:38:70:0f:41` on Express 7, a UX7 that meshes to the Lab AP over 5 GHz.
Its mesh radio runs around 15% retries every day; that is its baseline, not a
finding.
