---
title: Screen callers on the office phone
description: How the folly PBX screens unknown callers on line 4 and hands them to the ElevenLabs troll agent, how to add or remove a contact who skips the screen, what the star codes do, how to render the prompts, and how to test the screen.
---

The folly PBX answers unknown callers on line 4 and asks them to press 5. This
runbook adds and removes a contact who skips that screen, lists the star codes,
renders the prompts and tests the screen after a merge.
[Operate the office phone](operate-the-office-phone.md) covers the lines, the
trunks and a failed call.

## How the screen works

- Only line 4 screens. Its trunk carries `SCREEN=yes` in
  `clusters/folly/apps/pbx/config/pjsip.conf`. Line 1 does not screen: the
  handset dials 911 on it, and 911 calls back there.
- `config/inbound.conf` rings a contact, an unscreened line, and a screened
  line within an hour of a 911 from the handset. It answers anyone else and
  plays the press-5 prompt twice. A 5 rings the handset as `[5] <number>`. Any
  other answer goes to `config/agent.conf`, which dials Earl, the troll agent
  on [ElevenLabs](../apps/elevenlabs.md), for up to ten minutes.
- When the agent is off, on two calls already, or does not answer in 60
  seconds, `config/spam.conf` holds the caller for up to ten minutes in the
  Endless Queue or with Robo-Lenny. Two callers hear the prompt at once and
  three are held: the next stranger gets a busy signal, and the next held
  caller hears goodbye.
- The agent's number and credentials are the 1Password item
  `elevenlabs troll trunk`, read through the ExternalSecret `pbx-elevenlabs`
  when the pod starts. Without that Secret the agent is off.
- A contact rings as `[OK] <name>` with the Friend ring; a caller who pressed 5
  rings with the Human ring. Both are `Ring10` and `Ring11` in
  `provision/cathy.xml`.
- Each step logs one line, `pbx-event kind=<kind> line=<line> caller=<digits>`,
  from `config/events.conf`. `kind=troll-miss` names why the agent did not
  take a caller in `why=`. The PBX dashboard counts `kind=screened`, and so
  does the [Smiirl counter](operate-the-smiirl-counter.md).

## Before you start

- Get access to the `homelab` vault in 1Password.
- Get `kubectl` access to folly
  ([Get cluster admin access](get-cluster-admin-access.md)).

## Add a contact

> [!NOTE]
> A contact's name and number are in the PBX log in VictoriaLogs each time
> they call. The item is not the only copy.

1. In the `homelab` vault, open the item `pbx contacts`, or create it as a
   Secure Note. Keep one item with that title.

2. Add a text field. Make the label the name the handset shows and the value
   the ten-digit number, in any North American format. Keep every label in the
   item unique.

   > [!NOTE]
   > External Secrets fails the item on a repeated label or a second
   > item with the title, and then no contact skips the screen.

3. Make sure the ExternalSecret has synced. It refreshes every hour, and the
   pod's copy of the Secret follows within a minute or two.

   ```bash
   kubectl --context folly -n pbx get externalsecret pbx-contacts
   ```

   Result: `STATUS` is `SecretSynced`.

4. Reload the dialplan. Asterisk reads the contacts file when the dialplan
   loads, and nothing restarts the pod for this Secret.

   ```bash
   kubectl --context folly -n pbx exec deploy/pbx -c asterisk -- \
     /bin/asterisk -C /etc/asterisk/asterisk.conf -rx 'dialplan reload'
   ```

   Result: `Dialplan reloaded.` `dialplan show globals` then lists one
   `CONTACT_<ten digits>` line per contact.

## Remove a contact

> [!NOTE]
> A reload sets the globals the file still holds and clears none; only a
> restart forgets one. Delete the field, not the item: External Secrets keeps
> the Secret of a deleted item.

1. Delete the contact's field from the `pbx contacts` item.

2. Make sure the ExternalSecret has synced, as in step 3 of
   [Add a contact](#add-a-contact).

3. Make sure `core show channels` shows no active call, then restart the pod.

   ```bash
   kubectl --context folly -n pbx rollout restart deploy/pbx
   ```

   Result: after the pod starts, `dialplan show globals` lists no `CONTACT_`
   line for the number.

## Star codes

Dial a code from any line. `config/handset-codes.conf` sends each one to
`config/toybox.conf`.

| Code | What it does |
| --- | --- |
| `*20` | Echo test |
| `*21` | Talking clock, in the lab's time zone |
| `*22` | A Morse greeting |
| `*23` | Milliwatt tone |
| `*24` | The monkeys |
| `*25` | Listen to the held callers and the agent's calls; an error tone if there are none |
| `*26` | The number of callers the sinks have held since the pod started |
| `*27` | Robo-Lenny |
| `*28` | The Endless Queue |
| `*29` | Earl, the troll agent, in `desk` mode; an error tone if the agent is off or busy |

## Render the prompts

`clusters/folly/apps/pbx/sounds/lines.yaml` declares each prompt.
`mise run pbx:voices` renders the lines that have no `.ulaw` beside them with
ElevenLabs text-to-speech, and reads the key from the 1Password item
`rowbutt elevenlabs api key`. Pass line ids to render those, or `--all`. Add
each new file to `pbx-sounds` in `clusters/folly/apps/pbx/kustomization.yaml`;
the task names a file that is missing there. The prompts share a 700 KiB
budget, and `mise run pbx:check` fails if the dialplan plays a file the
ConfigMap does not carry.

## Test the screen

Place these calls after the pod rolls and the phone has fetched its profile
([Change the phone](operate-the-office-phone.md#change-the-phone)).

1. Call line 4 from a contact's number.

   Result: the handset shows `[OK] <name>` and plays the Friend ring.

2. Call line 4 from another number and press 5.

   Result: the prompt plays once, then the handset shows `[5] <number>` and
   plays the Human ring.

3. Call line 4 from that number again and press nothing.

   Result: Earl answers, and `*25` on the handset plays the call.

4. Dial `*29`.

   Result: Earl answers and plays up the demo.

5. Dial `*20` from each line.

   Result: the phone plays the echo test. A reorder tone means the line's
   `Dial_Plan` on the phone does not send `*xx`.

6. Dial 933 from line 1.

   Result: voip.ms reads the e911 address back.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| A caller on line 4 hears "press five", talks to Earl, or is held in the queue or with Lenny | Line 4 screens every caller who is not a contact. | Add them as a contact, or tell them to press 5. |
| Screened callers are held, never trolled, and the log has `why=off` | The pod started without the `pbx-elevenlabs` Secret. | Make sure `kubectl --context folly -n pbx get externalsecret pbx-elevenlabs` shows `SecretSynced`, then restart the pod when no call is up. |
| The log has `why=CONGESTION`, `CHANUNAVAIL` or `BUSY` | ElevenLabs refused the call or was unreachable, or the agent hit its daily cap. | Read the agent's SIP ([Diagnose a failed call](operate-the-office-phone.md#diagnose-a-failed-call)). |
| A caller on line 4 gets a busy signal | Two callers are in the screen. | Wait, or raise the cap in `config/inbound.conf`. |
| `pbx-contacts` shows `SecretSyncedError` | The `pbx contacts` item is missing, has a repeated label, or shares its title with another item. No alert covers it. | Fix the item. The ExternalSecret retries within the hour. |
| A new contact still hears the screen | Asterisk read the contacts file at its last dialplan load, or the value is not ten digits and the template skipped it. | Run `dialplan reload` after the Secret has caught up. If `dialplan show globals` has no line for it, fix the value. |
| A removed contact still skips the screen | A reload keeps the global, or the item was deleted and its Secret kept. | Restart the pod. If the item is gone, recreate it without the field first. |
| `[OK]` or `[5]` shows with the line's usual ring | The phone has not fetched the profile with `Ring10` and `Ring11`. | Resync the phone ([Change the phone](operate-the-office-phone.md#change-the-phone)). |

## Related

- [Operate the office phone](operate-the-office-phone.md)
- [PBX](../apps/pbx.md)
- [Operate the Smiirl counter](operate-the-smiirl-counter.md)
