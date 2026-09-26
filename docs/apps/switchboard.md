---
title: Switchboard
description: A Bun service on offsite that rings the owner's phone through an ElevenLabs voice agent. Deployed, parked at zero replicas.
status: parked
---

Switchboard rings the owner's cell for mate and Alertmanager: ElevenLabs dials it over voip.ms and hands the call to the `pbx-switchboard` agent, which says one message. The Deployment is parked at zero replicas until the 1Password item `switchboard` exists.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| `POST /ring` | `http://switchboard.elevenlabs.svc.cluster.local:8080` | mate's sandbox pods, with the ring token |
| `POST /alertmanager` | The same Service | offsite's Alertmanager, with the alert token |

## Limits

- Each caller class rings at most three times a day, ten minutes apart. Alerts ring for a firing `critical` alert other than `Watchdog`, outside 23:00 to 08:00 America/Halifax.
- The agent takes one call at a time, ten a day, 180 seconds each, and hangs up after 15 seconds of silence.
- It dials `SWITCHBOARD_TO_NUMBER` and no other number.

## How it works

Switchboard runs in offsite's `elevenlabs` namespace with the write key the [ElevenLabs](elevenlabs.md) reconciler holds. At boot it lists the agents and keeps the id of the one named `SWITCHBOARD_AGENT_NAME`; none, or two, exits with status 64. `SWITCHBOARD_AGENT_ID` skips the lookup.

Each request carries its class's bearer token. A call goes to the outbound-call endpoint, bounded by a timeout and never retried; the daily cap counts attempts, and `/alertmanager` dedupes by fingerprint until the alert resolves. The log has each outcome and never a number, URL, body or token. A CiliumNetworkPolicy admits the two callers; the pod reaches nothing but `api.elevenlabs.io`.

## Unpark it

1. In the voip.ms portal, confirm that the sub-account `168847_elevenlabs` allows encrypted SIP, has international and premium calling off, and has a caller ID with no e911 address. Git does not hold these settings, and they set what a call can reach and cost.
2. Check that a reconcile run logs `and an outbound trunk`. The number dials out as `168847_elevenlabs`, whose password `clusters/offsite/apps/elevenlabs/external-secret.yaml` reads from the item `voip.ms sub accounts`.
3. In the `homelab` vault, create `switchboard` (`to-number` as E.164, `ring-token`, `alert-token`).
4. The pinned image must have `apps/switchboard/src/agent.ts`; an older build logs `SWITCHBOARD_AGENT_ID is required` and exits. `bash .github/scripts/cd-digest-update.sh revision jonpulsifer/switchboard <digest>` names a digest's commit.
5. Set `replicas: 1` in `switchboard.yaml` and merge. voip.ms can hold a sub-account that starts dialling out from somewhere new as a fraud check: a bare 503 after 100 Trying.

## Operate

No alert watches switchboard. A refused ring answers 429 with a `skipped` reason, a failed call 502.

## Reference

- Source: `apps/switchboard/`
- Manifests: `clusters/offsite/apps/elevenlabs/switchboard.yaml`
- Agent: `clusters/offsite/apps/elevenlabs/desired/agents/pbx-switchboard.json`
- Image: `ghcr.io/jonpulsifer/switchboard`
