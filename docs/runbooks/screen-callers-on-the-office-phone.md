---
title: Screen callers on the office phone
description: How the folly PBX screens unknown callers on line 4, how to add a contact who skips the screen, what the star codes do, and how to render the prompts.
---

The folly PBX answers unknown callers on line 4 and asks them to press 5. This
runbook adds a contact who skips that screen, lists the star codes, and renders
the prompts. [Operate the office phone](operate-the-office-phone.md) covers the
lines, the trunks and a failed call.

## How the screen works

- Only line 4 screens. Its trunk carries `SCREEN=yes` in
  `clusters/folly/apps/pbx/config/pjsip.conf`. Line 1 does not screen: the
  handset dials 911 on it, and 911 calls back there.
- `config/inbound.conf` rings a contact, an unscreened line, and a screened
  line within an hour of a 911 from the handset. It answers anyone else and
  plays the press-5 prompt twice. A 5 rings the handset as `[5] <number>`. Any
  other answer goes to `config/spam.conf`, which holds the caller for up to ten
  minutes in the Endless Queue or with Robo-Lenny. Three callers are held at
  once; the fourth hears goodbye.
- A contact rings as `[OK] <name>` with the Friend ring; a caller who pressed 5
  rings with the Human ring. Both are `Ring10` and `Ring11` in
  `provision/cathy.xml`.
- Each step logs one line, `pbx-event kind=<kind> line=<line> caller=<digits>`,
  from `config/events.conf`. The PBX dashboard counts `kind=screened`, and so
  does the [Smiirl counter](operate-the-smiirl-counter.md).

## Before you start

- Get access to the `homelab` vault in 1Password.
- Get `kubectl` access to folly
  ([Get cluster admin access](get-cluster-admin-access.md)).

## Add a contact

1. In the `homelab` vault, open the item `pbx contacts`, or create it as a
   Secure Note. Keep one item with that title.

2. Add a text field. Make the label the name the handset shows and the value
   the number, in any North American format. Keep every label in the item
   unique.

   > [!NOTE]
   > External Secrets fails the whole item on a repeated label or a second
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
| `*25` | Listen to the held callers; an error tone if nobody is held |
| `*26` | The number of callers held since the pod started |
| `*27` | Robo-Lenny |
| `*28` | The Endless Queue |

## Render the prompts

`clusters/folly/apps/pbx/sounds/lines.yaml` declares each prompt.
`mise run pbx:voices` renders the lines that have no `.ulaw` beside them with
ElevenLabs text-to-speech, and reads the key from the 1Password item
`rowbutt elevenlabs api key`. Pass line ids to render those, or `--all`. Add
each new file to `pbx-sounds` in `clusters/folly/apps/pbx/kustomization.yaml`;
the task names a file that is missing there. The prompts share a 700 KiB
budget, and `mise run pbx:check` fails if the dialplan plays a file the
ConfigMap does not carry.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| A caller on line 4 hears "press five", or is held in the queue or with Lenny | Line 4 screens every caller who is not a contact. | Add them as a contact, or tell them to press 5. |
| `pbx-contacts` shows `SecretSyncedError` | The `pbx contacts` item is missing, has a repeated label, or shares its title with another item. No alert covers it. | Fix the item. The ExternalSecret retries within the hour. |
| A new contact still hears the screen | Asterisk read the contacts file at its last dialplan load. | Run `dialplan reload` after the Secret and the pod's copy have caught up. |
| `[OK]` or `[5]` shows with the line's usual ring | The phone has not fetched the profile with `Ring10` and `Ring11`. | Resync the phone ([Change the phone](operate-the-office-phone.md#change-the-phone)). |

## Related

- [Operate the office phone](operate-the-office-phone.md)
- [PBX](../apps/pbx.md)
- [Operate the Smiirl counter](operate-the-smiirl-counter.md)
