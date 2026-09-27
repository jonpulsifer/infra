---
title: Operate the offsite PBX
description: Check the offsite PBX, which hands every call on the voip.ms sub-account 168847_elevenlabs to the ElevenLabs troll agent, and find why a call failed.
---

This runbook checks the offsite [PBX](../apps/pbx.md). That Asterisk takes every call voip.ms delivers to the sub-account `168847_elevenlabs` and hands it to the troll agent at [ElevenLabs](../apps/elevenlabs.md). Use it when `PBXDown` or `PBXTrunkNotRegistered` fires on offsite, or when a troll call fails.

## Before you start

- Get `kubectl` access to offsite ([Get cluster admin access](get-cluster-admin-access.md)).
- Get access to offsite's VictoriaLogs.

The config is `clusters/offsite/apps/pbx/`. A merge under that directory or `clusters/base/apps/pbx/` restarts the pod, and so does a change to its `pbx-secrets`.

## Check the registration

1. Show the registration.

   ```sh
   kubectl --context offsite -n pbx exec deploy/pbx -c asterisk -- \
     /bin/asterisk -C /etc/asterisk/asterisk.conf -rx 'pjsip show registrations'
   ```

   Result: `vms-elevenlabs` shows `Registered`, over TLS to the numbered server that `pbx-env` names.

2. Show the identifies.

   ```sh
   kubectl --context offsite -n pbx exec deploy/pbx -c asterisk -- \
     /bin/asterisk -C /etc/asterisk/asterisk.conf -rx 'pjsip show identifies'
   ```

   Result: One identify for `vms-elevenlabs`, on `X-Dest-User: 168847_elevenlabs`.

## Read a call

> [!NOTE]
> The caller ID on a transferred call is whatever voip.ms presents. The dialplan logs it and passes it to the agent, and routes on nothing it carries.

1. In offsite's VictoriaLogs, query the call events.

   ```text
   {namespace="pbx", container="asterisk"} "pbx-event"
   ```

   Result: Each call logs `kind=inbound`. Then it logs `kind=troll` and `kind=held` with its length, or `kind=troll-miss` with a `why`.

2. Remove `"pbx-event"` from the query to read the SIP of the call.

   Result: voip.ms sends the `INVITE` down the registration's TLS connection. It addresses `s` with a `line` parameter, or digits with `X-Dest-User: 168847_elevenlabs`.

## If something goes wrong

Offsite refuses every call the agent does not take before it answers, so voip.ms sees that call fail.

| Symptom | Cause | Action |
| --- | --- | --- |
| `vms-elevenlabs` shows `Rejected`, and `PBXTrunkNotRegistered` shows 2 | voip.ms refuses the password. The PBX tries again every 10 minutes. | Make sure the `168847_elevenlabs` field of the item `voip.ms sub accounts` holds the sub-account's password. |
| The registration shows `Registered`, and no `INVITE` arrives | voip.ms fraud protection can hold a sub-account that takes its first calls. Or the DID's POP is not the numbered server. | Ask voip.ms support to release the sub-account. Make sure the DID's POP matches `pbx-env`. |
| `kind=troll-miss why=full` or `why=daily`, answered `486` | The agent has two calls, or twenty answered today. | None. The first cap clears when a call ends. The day's count starts again on the next date, or at a restart. |
| `kind=troll-miss why=off`, answered `503` | `agent-did` in the item `elevenlabs troll trunk` is empty. | Set `agent-did` to the number imported at ElevenLabs. |
| `kind=troll-miss why=CONGESTION` or `why=CHANUNAVAIL`, answered `503` | The PBX cannot reach the agent. `why=BUSY` answers `486`, and any other Dial status `503`. | Read the `elevenlabs` rows in [Diagnose a failed call](operate-the-office-phone.md#diagnose-a-failed-call). |

## Related

- [PBX](../apps/pbx.md)
- [ElevenLabs](../apps/elevenlabs.md)
- [Operate the office phone](operate-the-office-phone.md): the folly PBX, and how to read its SIP
