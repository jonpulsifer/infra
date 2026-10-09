---
title: Switchboard
description: A Bun service with two roles, a live board of the folly PBX's calls and a ringer on offsite that phones the owner through an ElevenLabs voice agent.
status: live
---

Switchboard is one image with two roles, which `SWITCHBOARD_ROLE` picks. The [board](switchboard/board.md) shows the folly PBX's calls. The ringer, this page, rings the owner's cell for mate and Alertmanager: ElevenLabs dials it over voip.ms and hands the call to the `pbx-switchboard` agent, which says one message.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| `POST /ring` | `http://switchboard.elevenlabs.svc.cluster.local:8080` | mate's sandbox pods, with the ring token |
| `POST /alertmanager` | The same Service | offsite's Alertmanager, with the alert token |
| `POST /mission` | The same Service | mate's sandbox pods, with the mission token |
| `GET /mission/:conversationId` | The same Service | The same callers, with the mission token |

A mission sends `{target, keyword}` and optionally `name`, `objective` and `wait`. Earl, the `pbx-mission` agent, phones the target with a secret objective: get them to say the keyword. Without `wait` the answer is 202 with the conversation id, and the `GET` route returns `pending` or `done` with the scored result. With `wait: true` the answer holds until the call is scored.

## Limits

- Each caller class rings at most three times a day, ten minutes apart. Alerts ring for a firing `critical` alert other than `Watchdog`, outside 23:00 to 08:00 America/Halifax.
- The agent takes one call at a time, ten a day, 180 seconds each, and hangs up after 15 seconds of silence.
- It dials `SWITCHBOARD_TO_NUMBER` and no other number.
- A mission dials only a key of the allow-list; an unknown `target` answers 404, and no response or log carries a number.
- Missions ring at most five times a day (`SWITCHBOARD_MISSION_DAILY_CAP`), `SWITCHBOARD_COOLDOWN_MINUTES` apart, outside the same quiet hours as alerts. A refusal answers 429 with a `skipped` reason.
- A mission call lasts at most five minutes. The pod polls ElevenLabs every five seconds for up to seven minutes to score it.

## How it works

Switchboard runs in offsite's `elevenlabs` namespace with the write key the [ElevenLabs](elevenlabs.md) reconciler holds. At boot it lists the agents and keeps the id of the one named `SWITCHBOARD_AGENT_NAME`; none, or two, exits with status 64. `SWITCHBOARD_AGENT_ID` skips the lookup.

Each request carries its class's bearer token. A call goes to the outbound-call endpoint, bounded by a timeout and never retried; the daily cap counts attempts, and `/alertmanager` dedupes by fingerprint until the alert resolves or the pod restarts. The log has each outcome and never a number, URL, body or token. A CiliumNetworkPolicy admits the two callers; the pod reaches nothing but `api.elevenlabs.io`.

Missions are on only when the Secret `switchboard-mission` holds a `token` and at least one target. The pod then resolves the agent named `SWITCHBOARD_MISSION_AGENT_NAME` (`pbx-mission`) at boot; without them it skips the lookup and `POST /mission` answers 503. An agent that is missing or ambiguous logs `missions off` and also answers 503; the ringer still boots, so alerts never depend on the mission agent. The `keyword` is 1 to 40 letters, spaces, hyphens or apostrophes, and the call sets it as an ASR keyword. The score reads the conversation's transcript: a `user` turn that holds the keyword, as a whole word with an optional `s` or `es`, before any `agent` turn that does, is a win. The log has one `mission result` line for each call, with the target key and never the number or the transcript. The newest 50 results stay in memory, so a restart clears them.

## The mission item

The 1Password item `mission targets` in the `homelab` vault fills the Secret `switchboard-mission` through the ExternalSecret in `clusters/offsite/apps/elevenlabs/switchboard.yaml`. Each field label is a target key and its value that person's number as E.164. The field `token` is the mission bearer token. The Secret mounts at `SWITCHBOARD_TARGETS_DIR` (`/targets`); a malformed number exits the pod with status 64.

## Unpark it

1. In the voip.ms portal, confirm that the sub-account `168847_elevenlabs` allows encrypted SIP, has international and premium calling off, and has a caller ID with no e911 address. Git does not hold these settings, and they set what a call can reach and cost.
2. Check that a reconcile run logs `and an outbound trunk`. The number dials out as `168847_elevenlabs`, whose password `clusters/offsite/apps/elevenlabs/external-secret.yaml` reads from the item `voip.ms sub accounts`.
3. In the `homelab` vault, create `switchboard` (`to-number` as E.164, `ring-token`, `alert-token`).
4. The pinned image must have `apps/switchboard/src/agent.ts`; an older build logs `SWITCHBOARD_AGENT_ID is required` and exits. `bash .github/scripts/cd-digest-update.sh revision jonpulsifer/switchboard <digest>` names a digest's commit.
5. Set `replicas: 1` in `switchboard.yaml` and merge. voip.ms can hold a sub-account that starts dialling out from somewhere new as a fraud check: a bare 503 after 100 Trying.

## Operate

No alert watches switchboard. A refused ring answers 429 with a `skipped` reason, a failed call 502. A 503 from `/mission` means the item `mission targets` is missing, has no `token` or has no target; add the field and the ExternalSecret refresh rolls the pod.

Two callers on offsite are declared for it. mate gives each Rowbutt sandbox `SWITCHBOARD_URL` and the ring token, and the `switchboard` AlertmanagerConfig in `clusters/offsite/monitoring/` posts a firing `critical` alert to `/alertmanager`. That config is selected only once `switchboard` is in `alertmanagerConfigSelector` in `clusters/offsite/monitoring/kube-prometheus.yaml`. Add it in its own merge after a switchboard pod is Ready, and drop it before parking; [Alerting](../platform/observability/alerting.md) has the rule.

## Reference

- Source: `apps/switchboard/`
- Manifests: `clusters/offsite/apps/elevenlabs/switchboard.yaml`, and the board's in `clusters/folly/apps/pbx/switchboard.yaml`
- Agent: `clusters/offsite/apps/elevenlabs/desired/agents/pbx-switchboard.json`; the mission agent is `pbx-mission` in the same directory
- Image: `ghcr.io/jonpulsifer/switchboard`
