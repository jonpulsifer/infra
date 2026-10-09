---
name: switchboard
description: >-
  Ring the owner's phone through switchboard, or send Earl on a mission to
  phone a family member and get them to say a word. Use when the owner asks to
  be called, rung or phoned, says "call me", or asks for a mission, a prank
  call, or to make someone say a word.
metadata:
  wiki: https://wiki.lolwtf.ca/apps/switchboard/
---

# Switchboard

The service page is `docs/apps/switchboard.md`. These notes cover what an
agent needs beyond it.

## Ring

When the owner asks to be called, send one request and read the status code:

```bash
curl -sS --max-time 100 -w '\n%{http_code}\n' -X POST "$SWITCHBOARD_URL/ring" \
  -H "Authorization: Bearer $SWITCHBOARD_RING_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"<one short line>"}'
```

- `200`: the call is placed. Say so. The answer comes only once the owner
  picks up or the ring times out, so the wait can run over a minute.
- `429`: refused. The body's `skipped` field says why, `daily-cap` or
  `cooldown`. Report the reason and do not retry.
- `502`: the call was attempted once and failed. Report it and do not retry.
- `401`, or either variable unset: this sandbox has no ring token. Say so.
- `000`, with a curl error instead of a response (name not resolved,
  connection refused, or the timeout): switchboard is parked, as
  `docs/apps/switchboard.md` says. Say so and do not retry.

## Mission

When the owner asks to send the caller after someone with a word, write a
cover story, send one request and wait for the score. `target` is a key of
switchboard's allow-list: `parents`, `dad` or `owner`. `keyword` is the word
the person has to say. `name` is what the caller calls them; leave it out to
use the key. The caller speaks in the owner's voice and never introduces
itself.

`scenario` is the cover story, four to six sentences, and it is what makes the
call sound like a call: a reason the owner would phone this person today, how
to ease in (how they are, what they're up to), the story that has a gap only
they can fill, which is the keyword, what to call the thing instead of its
name, and what to ask after they say it so the call carries on a beat before
the goodbye. Write it for the person named, not for the owner. Without one
the caller invents a reason itself. A mission call lasts up to five minutes
and the score comes two minutes after at most, so the wait is long:

```bash
curl -sS --max-time 480 -w '\n%{http_code}\n' -X POST "$SWITCHBOARD_URL/mission" \
  -H "Authorization: Bearer $SWITCHBOARD_MISSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"target":"dad","keyword":"turkey","name":"Dad","wait":true,
       "scenario":"<the cover story, one paragraph>"}'
```

- `200` with `result`: report it as a story: `won`, `secondsToWin`, `turn`,
  `agentSaidFirst` (Earl cheated), `fairPlay` and `keywordWon` (ElevenLabs'
  judges), `howItHappened` and `winningLine`.
- `200` with `status: pending`: the call ran long. Poll
  `GET "$SWITCHBOARD_URL/mission/<conversationId>"` with the same bearer every
  30 seconds, up to five times, for `status: done`.
- `429`: refused. `skipped` is `daily-cap`, `cooldown` or `quiet-hours`.
  Report it and do not retry.
- `404`: no such target. Name the three keys and do not guess a number.
- `400`: the keyword is not 1-40 letters, spaces, hyphens or apostrophes.
- `503`: missions are off on the server. Say so.
- `502`, `401` and `000`: as for a ring, with the mission token.

## Notes

- The number is fixed on the server, and no request can choose another. A
  mission dials only a key of the allow-list. There is no other way to place
  a call: no PBX, no ElevenLabs API, no voip.ms.
- The reason is one line the agent on the call reads to the owner. Keep it
  short, with no secret in it. Print only the body and the status code; the
  token never goes in a message or a log.
- A workstation session has no ring token, so the `401` or unset branch
  applies. Say so and do not look for one.
