---
title: ElevenLabs
description: The voice agents and the phone number that git declares for the PBX and Switchboard, and the offsite CronJob that makes the ElevenLabs account match them.
status: live
---

ElevenLabs hosts the lab's voice agents and the SIP trunk that joins them to voip.ms. `clusters/offsite/apps/elevenlabs/desired/` declares the agents and the phone number, and the CronJob `elevenlabs-reconcile` on offsite makes the account match it every 15 minutes. The [PBX](pbx.md) sends screened callers to the troll agent, and [Switchboard](switchboard.md) rings the owner through the other.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| The number's inbound trunk | `agent-did` in the item `elevenlabs troll trunk` | The offsite PBX, for every call on `168847_elevenlabs`, and the folly PBX, for the calls its own dialplan sends there; both with that item's digest credentials |
| The outbound number | A second SIP-trunk number whose number string is the sub-account `168847_elevenlabs`, so each INVITE's From user names the sub-account, which voip.ms requires. It dials voip.ms over UDP with plain RTP, as the sub-account's encrypted SIP setting is off; voip.ms's TLS port negotiates only RSA key exchange, which ElevenLabs' SIP stack refuses. Switchboard dials out on it. | Anyone holding the `elevenlabs pbx api key`, which Switchboard uses through the outbound-call API |

## Limits

- The write key, item `elevenlabs pbx api key`, exists only in offsite's `elevenlabs` namespace.
- The outbound number gets its trunk only once the Secret `elevenlabs-outbound-trunk` holds its username and password; until then each run logs that the trunk waits.
- With that Secret in hand, the number dials out as `168847_elevenlabs` for anyone who holds the write key, on the voip.ms balance folly's lines share. The sub-account's voip.ms settings, which git does not hold, set what such a call can reach and cost.
- ElevenLabs holds that sub-account's password, and anyone who has it can register the sub-account and take the calls of any DID routed to it.
- The offsite PBX registers `168847_elevenlabs` and takes every call voip.ms delivers to it. Another client registered with that password can take those calls instead.
- A live outbound trunk whose password git does not hold fails the Job.
- The folly [PBX](pbx.md) reads a rotated `elevenlabs troll trunk` only when it restarts, and sends troll calls to its sinks until then.
- The offsite PBX reads `elevenlabs troll trunk` through its `pbx-secrets`, which Reloader watches, so a rotation restarts it and cuts any call on it.

## How it works

`desired/agents/` holds one agent per file: `pbx-troll`, `pbx-switchboard` and `pbx-mission`, the mission caller in the owner's voice, which [Switchboard](switchboard.md) sends after a family member with a word to get out of them. `desired/phone-number.json` names the agent that answers the DID number and declares its inbound trunk, and a trunk on that number that git does not declare is removed. `desired/outbound-number.json` declares the outbound number, `168847_elevenlabs`, and its trunk. Each run of `reconcile.sh` creates an agent no live one is named after, patches the declared fields that differ, binds the DID number with one PATCH of the agent and the full inbound trunk with its digest credentials, and, with the Secret in hand, patches the outbound number with its full trunk and credentials. The API never returns a password, so every write run re-sends them. It logs field names, never values.

An agent's persona is edited live, not through git: the first message, the closing message, the prompt text and the `tts` block (voice, model, stability, similarity, speed, expressive mode and suggested tags). `reconcile.sh` names those leaves in `persona`, sends none of them in a PATCH, and logs `persona differs from the file` when the live value is not the file's. The file seeds a new agent with them and otherwise holds the last snapshot of what is live. Everything else in the file, the tools, the LLM, the limits, the judges and the number bindings, is git's as before.

A failed request for one agent fails the Job and leaves that agent as it is; the other agents and the number are still reconciled. If ElevenLabs reports no inbound credentials after the bind, the run unbinds the number. Without the write key it only logs what it would create, patch or bind.

## Operate

No alert is specific to it. A failed run fires `KubeJobFailed`, and the Job's log names the HTTP status or the field at fault.

## Reference

- Manifests and desired state: `clusters/offsite/apps/elevenlabs/`
- Test: `mise run elevenlabs:test` runs `reconcile.sh` against a stubbed API
- Items in the `homelab` vault, one Secret each: `rowbutt elevenlabs api key` to read, `elevenlabs pbx api key` to write, `elevenlabs troll trunk` for the inbound credentials, and the `168847_elevenlabs` field of `voip.ms sub accounts` for the outbound sub-account's password
