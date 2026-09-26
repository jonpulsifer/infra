---
title: ElevenLabs
description: The voice agents and the phone number that git declares for the PBX and Switchboard, and the offsite CronJob that makes the ElevenLabs account match them.
status: live
---

ElevenLabs hosts the lab's voice agents and the SIP trunk that joins them to voip.ms. `clusters/offsite/apps/elevenlabs/desired/` declares the agents and the phone number, and the CronJob `elevenlabs-reconcile` on offsite makes the account match it every 15 minutes. The [PBX](pbx.md) sends screened callers to the troll agent, and [Switchboard](switchboard.md) rings the owner through the other.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| The number's inbound trunk | `agent-did` in the item `elevenlabs troll trunk` | The folly PBX, with that item's digest credentials |
| The number's outbound trunk | voip.ms over TLS, as the sub-account `168847_elevenlabs` | Anyone holding the `elevenlabs pbx api key`, which Switchboard uses through the outbound-call API |

## Limits

- The write key, item `elevenlabs pbx api key`, exists only in offsite's `elevenlabs` namespace.
- The number gets an outbound trunk only once the Secret `elevenlabs-outbound-trunk` holds its username and password; until then each run logs that the trunk waits.
- With that Secret in hand, the number dials out as `168847_elevenlabs` for anyone who holds the write key, on the voip.ms balance folly's lines share. The sub-account's voip.ms settings, which git does not hold, set what such a call can reach and cost.
- ElevenLabs holds that sub-account's password, and anyone who has it can register the sub-account and take the calls of any DID routed to it.
- A live outbound trunk whose password git does not hold fails the Job.
- The folly PBX reads `elevenlabs troll trunk` through its own ExternalSecret, `pbx-elevenlabs`. After a rotation, troll calls fall back to the PBX's sinks until both sides hold the new password.

## How it works

`desired/agents/` holds one agent per file, `pbx-troll` and `pbx-switchboard`. `desired/phone-number.json` names the agent that answers the number, its inbound trunk and its outbound trunk. Each run of `reconcile.sh` creates an agent no live one is named after, patches the declared fields that differ, and binds the number with one PATCH: the agent, the full inbound trunk with its digest credentials and, with the Secret in hand, the outbound trunk with its credentials. The API never returns a password, so every write run re-sends them. It logs field names, never values.

A failed request for one agent fails the Job and leaves that agent as it is; the other agents and the number are still reconciled. If ElevenLabs reports no inbound credentials after the bind, the run unbinds the number. Without the write key it only logs what it would create, patch or bind.

## Operate

No alert is specific to it. A failed run fires `KubeJobFailed`, and the Job's log names the HTTP status or the field at fault.

## Reference

- Manifests and desired state: `clusters/offsite/apps/elevenlabs/`
- Test: `mise run elevenlabs:test` runs `reconcile.sh` against a stubbed API
- Items in the `homelab` vault, one Secret each: `rowbutt elevenlabs api key` to read, `elevenlabs pbx api key` to write, `elevenlabs troll trunk` for the inbound credentials, and the `168847_elevenlabs` field of `voip.ms sub accounts` for the outbound sub-account's password
