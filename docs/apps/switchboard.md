---
title: Switchboard
description: A Bun service on offsite that rings the owner's phone through an ElevenLabs voice agent. Deployed, parked at zero replicas.
status: parked
---

Switchboard places one outbound call at a time: ElevenLabs dials the owner's
cell over voip.ms and hands the call to the `pbx-switchboard` agent, which
says one message. mate's sandboxes and offsite's Alertmanager are its callers.
The Deployment is parked at zero replicas until two 1Password items exist.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| `POST /ring` | `http://switchboard.elevenlabs.svc.cluster.local:8080` | mate's sandbox pods, with the ring token |
| `POST /alertmanager` | The same Service | offsite's Alertmanager, with the alert token |

## Limits

- Parked: `clusters/offsite/apps/elevenlabs/switchboard.yaml` sets zero
  replicas, so nothing answers today.
- Each caller class rings at most three times a day, ten minutes apart.
  Alerts ring for a firing `critical` alert other than `Watchdog`, outside
  23:00 to 08:00 America/Halifax.
- The agent takes one call at a time, ten a day, 180 seconds each, and hangs
  up after 15 seconds of silence.
- It dials one number, `SWITCHBOARD_TO_NUMBER`. No request can choose another.

## How it works

Switchboard runs in offsite's `elevenlabs` namespace beside the reconciler,
with the same write key. At boot it lists the ElevenLabs agents and keeps the
id of the one named `SWITCHBOARD_AGENT_NAME`, `pbx-switchboard` by default.
No agent of that name, or two of them, is a config error, and the process
exits with status 64. `SWITCHBOARD_AGENT_ID` skips the lookup.

Each request carries its class's bearer token. A call goes to ElevenLabs'
outbound-call endpoint through the phone number's outbound trunk, bounded by a
timeout and never retried, and the daily cap counts attempts. `/alertmanager`
dedupes by fingerprint until the alert resolves. It logs an outcome and never
the destination number, a URL, a request body or a token. A
CiliumNetworkPolicy admits mate's sandbox pods and Alertmanager, and lets the
pod reach `api.elevenlabs.io` and nothing else.

## Unpark it

Two items in the 1Password vault `homelab` fill the Secrets:

| Item | Fields | Secret |
| --- | --- | --- |
| `switchboard` | `to-number` (the cell, E.164), `ring-token`, `alert-token` | `switchboard-config` |
| `elevenlabs outbound trunk` | `username` and `password` of a voip.ms sub-account | `elevenlabs-outbound-trunk`, read by the reconciler |

The owner creates the voip.ms sub-account for outbound calls alone:
international and premium calling off, a low balance cap, SRTP on, and a
caller ID with no e911 address. Once the reconciler reports the outbound trunk
bound, set `replicas: 1` in `switchboard.yaml` and merge. voip.ms holds the
first call from a new sub-account as a fraud check.

## Operate

No alert watches switchboard. A refused ring answers 429 with a `skipped`
reason, a failed call answers 502, and the pod's log has each outcome.

## Reference

- Source: `apps/switchboard/`
- Manifests: `clusters/offsite/apps/elevenlabs/switchboard.yaml`
- Agent: `clusters/offsite/apps/elevenlabs/desired/agents/pbx-switchboard.json`
- Image: `ghcr.io/jonpulsifer/switchboard`, built by `.github/workflows/containers.yml`; `.github/containers.json` names the manifest CD rolls
