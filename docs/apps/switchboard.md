---
title: Switchboard
description: A Bun service on offsite that rings the owner's phone through an ElevenLabs voice agent. Deployed, parked at zero replicas.
status: parked
---

Switchboard rings the owner's cell for mate and for Alertmanager: ElevenLabs dials it over voip.ms and hands the call to the `pbx-switchboard` agent, which says one message. The Deployment is parked at zero replicas until two 1Password items exist.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| `POST /ring` | `http://switchboard.elevenlabs.svc.cluster.local:8080` | mate's sandbox pods, with the ring token |
| `POST /alertmanager` | The same Service | offsite's Alertmanager, with the alert token |

## Limits

- Each caller class rings at most three times a day, ten minutes apart. Alerts ring for a firing `critical` alert other than `Watchdog`, outside 23:00 to 08:00 America/Halifax.
- The agent takes one call at a time, ten a day, 180 seconds each, and hangs up after 15 seconds of silence.
- It dials `SWITCHBOARD_TO_NUMBER`; no request can choose another number.

## How it works

Switchboard runs in offsite's `elevenlabs` namespace with the write key the [ElevenLabs](elevenlabs.md) reconciler holds. At boot it lists the agents and keeps the id of the one named `SWITCHBOARD_AGENT_NAME`; none, or two, exits with status 64. `SWITCHBOARD_AGENT_ID` skips the lookup.

Each request carries its class's bearer token. A call goes to the outbound-call endpoint, bounded by a timeout and never retried; the daily cap counts attempts, and `/alertmanager` dedupes by fingerprint until the alert resolves. The log has each outcome and never a number, URL, body or token. A CiliumNetworkPolicy admits the two callers; the pod reaches nothing but `api.elevenlabs.io`.

## Unpark it

1. Create a voip.ms sub-account for outbound calls alone: international and premium calling off, a low balance cap, SRTP on, a caller ID with no e911 address.
2. In the `homelab` vault, create `switchboard` (`to-number` as E.164, `ring-token`, `alert-token`) and `elevenlabs outbound trunk` (the sub-account's `username`, `password`). Wait for a reconcile run to log `and an outbound trunk`.
3. Make sure the pinned image has `apps/switchboard/src/agent.ts`; a build without it logs `SWITCHBOARD_AGENT_ID is required` and exits. `bash .github/scripts/cd-digest-update.sh revision jonpulsifer/switchboard <digest>` names a digest's commit.
4. Set `replicas: 1` in `switchboard.yaml` and merge. voip.ms holds the first call from a new sub-account as a fraud check.

## Operate

No alert watches switchboard. A refused ring answers 429 with a `skipped` reason, a failed call 502; the pod's log has each outcome.

## Reference

- Source: `apps/switchboard/`
- Manifests: `clusters/offsite/apps/elevenlabs/switchboard.yaml`, which names the Secrets
- Agent: `clusters/offsite/apps/elevenlabs/desired/agents/pbx-switchboard.json`
- Image: `ghcr.io/jonpulsifer/switchboard`; `.github/containers.json` names the manifest CD rolls
