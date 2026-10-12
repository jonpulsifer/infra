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
| `POST /mission/rehearse` | The same Service | The same callers, with the mission token |
| `GET /persona`, `GET /persona/:name`, `PATCH /persona/:name` | The same Service | mate's sandbox pods, with the persona token |
| `POST /persona/:name/snapshot`, `POST /persona/:name/rehearse` | The same Service | The same callers, with the persona token |

A mission sends `{target, keyword}` and optionally `name`, `objective`, `scenario` and `wait`. The `pbx-mission` agent phones the target with a secret objective: get them to say the keyword. `scenario` is the cover story the call stands on, a few sentences at most; without one the agent invents a reason to call. Without `wait` the answer is 202 with the conversation id, and the `GET` route returns `pending` or `done` with the scored result. With `wait: true` the answer holds until the call is scored. A result carries the whole transcript as `transcript`, one `{role, secs, message}` per spoken turn.

A rehearsal takes the same body plus an optional `callee`, the simulated callee's character, and `turns`, the length of the exchange (16 by default, 30 at most). ElevenLabs plays the agent against that callee in text, and the transcript is scored the same way. Nothing is dialled, so `target` is optional and only names the callee, and neither the daily cap nor quiet hours apply.

## Personas

The persona routes edit the character of each agent live, which [ElevenLabs](elevenlabs.md) says is the first message, the closing message, the prompt text and the `tts` block. `GET /persona` lists the agents the routes may edit, by name, and whether a snapshot is possible. `GET /persona/:name` answers the live persona as one flat object: `first_message`, `max_conversation_duration_message`, `prompt` and `tts` with `voice_id`, `model_id`, `stability`, `similarity_boost`, `speed`, `expressive_mode` and `suggested_audio_tags`. `PATCH /persona/:name` takes any subset of that object, refuses the whole body on any other key with 400, writes the leaves to the agent and answers the live persona. The prompt is replaced whole, so a caller reads, edits and writes it.

Each write is then snapshotted: the pod reads the agent's file from `main`, sets the persona leaves in it to what is live, and opens a pull request from a `persona/<name>-<stamp>` branch with auto-merge armed, as the GitHub App mate pushes as. The answer's `snapshot` is `opened` with the pull request's URL, `unchanged` when the file already matches, `skipped` when the pod has no App key, or `failed` with the step that failed; the live edit stands in every case. `POST /persona/:name/snapshot` does the same for an edit made in the ElevenLabs dashboard. The reconciler never patches these leaves, so merging the snapshot changes nothing live.

`POST /persona/:name/rehearse` plays any agent against a simulated caller in text, `{caller, first_message?, turns?, dynamic_variables?}`, and answers the transcript and the audio tags the agent wrote, so a persona edit can be judged without a call. Nothing is dialled and no limit applies.

## Limits

- A persona write goes to one agent at a time; a second write to the same agent waits for the first's snapshot.
- Each caller class rings at most three times a day, ten minutes apart. Alerts ring for a firing `critical` alert other than `Watchdog`, outside 23:00 to 08:00 America/Halifax.
- The agent takes one call at a time, ten a day, 180 seconds each, and hangs up after 15 seconds of silence.
- It dials `SWITCHBOARD_TO_NUMBER` and no other number.
- A mission dials only a key of the allow-list; an unknown `target` answers 404, and no response or log carries a number.
- Missions ring at most five times a day (`SWITCHBOARD_MISSION_DAILY_CAP`), `SWITCHBOARD_COOLDOWN_MINUTES` apart, outside the same quiet hours as alerts. A refusal answers 429 with a `skipped` reason.
- A mission call lasts at most five minutes. The pod polls ElevenLabs every five seconds for up to seven minutes to score it.

## How it works

Switchboard runs in offsite's `elevenlabs` namespace with the write key the [ElevenLabs](elevenlabs.md) reconciler holds. At boot it lists the agents and keeps the id of the one named `SWITCHBOARD_AGENT_NAME`; none, or two, exits with status 64. `SWITCHBOARD_AGENT_ID` skips the lookup.

Each request carries its class's bearer token. A call goes to the outbound-call endpoint, bounded by a timeout and never retried; the daily cap counts attempts, and `/alertmanager` dedupes by fingerprint until the alert resolves or the pod restarts. The log has each outcome and never a number, URL, body or token. A CiliumNetworkPolicy admits the two callers; the pod reaches nothing but `api.elevenlabs.io`.

The persona routes are on only when the Secret `switchboard-persona` holds a `token`; the pod then resolves each agent `SWITCHBOARD_PERSONA_AGENTS` names (the three in `desired/agents/` by default) and skips, with a `persona agent skipped` line, one it cannot. The snapshot needs the App's private key at `SWITCHBOARD_GITHUB_APP_KEY_FILE` (Secret `switchboard-github-app`, the item mate's own `mate-github-app` reads) and `SWITCHBOARD_GITHUB_APP_ID`; the boot line `personas on` says whether it has them. A persona write logs the agent and the leaf names, never the text. Missions are on only when the Secret `switchboard-mission` holds a `token` and at least one target. The pod then resolves the agent named `SWITCHBOARD_MISSION_AGENT_NAME` (`pbx-mission`) at boot; without them it skips the lookup and `POST /mission` answers 503. An agent that is missing or ambiguous logs `missions off` and also answers 503; the ringer still boots, so alerts never depend on the mission agent. The `keyword` is 1 to 40 letters, spaces, hyphens or apostrophes, and the call sets it as an ASR keyword. The score reads the conversation's transcript: a `user` turn that holds the keyword, as a whole word with an optional `s` or `es`, before any `agent` turn that does, is a win. The log has one `mission result` line for each call, with the target key and never the number or the transcript. The newest 50 results stay in memory, so a restart clears them.

## The mission item

The 1Password item `mission targets` in the `homelab` vault fills the Secret `switchboard-mission` through the ExternalSecret in `clusters/offsite/apps/elevenlabs/switchboard.yaml`. Each field label is a target key and its value that person's number as E.164. The field `token` is the mission bearer token. The Secret mounts at `SWITCHBOARD_TARGETS_DIR` (`/targets`); a field that holds no E.164 number, such as a Secure Note's empty `notesPlain`, is skipped with a `mission target skipped` log line that names the key.

## Unpark it

1. In the voip.ms portal, confirm that the sub-account `168847_elevenlabs` allows encrypted SIP, has international and premium calling off, and has a caller ID with no e911 address. Git does not hold these settings, and they set what a call can reach and cost.
2. Check that a reconcile run logs `outbound trunk set with credentials` for the outbound number. The number dials out as `168847_elevenlabs`, whose password `clusters/offsite/apps/elevenlabs/external-secret.yaml` reads from the item `voip.ms sub accounts`.
3. In the `homelab` vault, create `switchboard` (`to-number` as E.164, `ring-token`, `alert-token`).
4. The pinned image must have `apps/switchboard/src/agent.ts`; an older build logs `SWITCHBOARD_AGENT_ID is required` and exits. `bash .github/scripts/cd-digest-update.sh revision jonpulsifer/switchboard <digest>` names a digest's commit.
5. Set `replicas: 1` in `switchboard.yaml` and merge. voip.ms can hold a sub-account that starts dialling out from somewhere new as a fraud check: a bare 503 after 100 Trying.

## Operate

No alert watches switchboard. A refused ring answers 429 with a `skipped` reason, a failed call 502. A 503 from `/mission` means the item `mission targets` is missing, has no `token` or has no target; add the field and the ExternalSecret refresh rolls the pod.

Two callers on offsite are declared for it. mate gives each Rowbutt sandbox `SWITCHBOARD_URL` and the ring token, and the `switchboard` AlertmanagerConfig in `clusters/offsite/monitoring/` posts a firing `critical` alert to `/alertmanager`. That config is selected only once `switchboard` is in `alertmanagerConfigSelector` in `clusters/offsite/monitoring/kube-prometheus.yaml`. Add it in its own merge after a switchboard pod is Ready, and drop it before parking; [Alerting](../platform/observability/alerting.md) has the rule.

## Reference

- Source: `apps/switchboard/`
- Manifests: `clusters/offsite/apps/elevenlabs/switchboard.yaml`, and the board's in `clusters/folly/apps/pbx/switchboard.yaml`
- Agent: `clusters/offsite/apps/elevenlabs/desired/agents/pbx-switchboard.json`; the mission agent is `pbx-mission` in the same directory, and a persona snapshot writes to these files
- Items in the `homelab` vault: `switchboard`, `mission targets`, `switchboard personas` (field `token`), and the GitHub App key mate's ExternalSecret names
- Image: `ghcr.io/jonpulsifer/switchboard`
