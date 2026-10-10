---
name: switchboard
description: >-
  Ring the owner's phone through switchboard, or send the mission caller, in the owner's voice, to
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
cover story, rehearse it, send one request and wait for the score. `target`
is a key of switchboard's allow-list: `parents`, `dad`, `nate` or `owner`.
`keyword` is the word the person has to say. `name` is what the caller calls
them ("Dad", "Nate"); leave it out to use the key.

The caller speaks in the owner's voice and is Jonathan: it never introduces
itself, opens with how they are and what they're at, and gets to the reason
for the call after a real exchange or two. It admits to being an AI when
sincerely asked and never asks for personal details.

`scenario` is the cover story, four to six sentences, and it is what makes the
call sound like a call. It says why Jonathan would phone this person today,
the thing he needs from them, how the gap opens (the keyword is the natural
answer), what to call the thing instead of its name, and what to ask after
they say it so the call carries on before the goodbye. Write it for the
person named, with facts that are true of the family. Recipes that work:

- Advice. Jonathan is in over his head with something (cooking the big
  dinner, fixing the car, planting the garden) and this is the person who
  knows. People give advice freely, and the keyword is the answer. Best by
  far for parents.
- The errand. Jonathan is at the store with a half-legible list someone sent
  him: what did they mean by "the big one", and what size?
- The plan. Something's being organised for the weekend and he needs one
  detail from them to do his part.

Without a scenario the caller invents a reason itself.

Rehearse before you dial. A rehearsal plays the caller against a simulated
callee in text, costs no phone call and no goodwill, and answers in under a
minute. Send the same body to `/mission/rehearse`, with `callee` describing
who answers (their mood, how much they volunteer, what they know) and `turns`
if sixteen is not enough. Read the transcript: did the reason for the call
hold up, did the gap open naturally, did the caller talk too much or ask the
same thing twice. Fix the cover story and rehearse again until it wins
without feeling like a quiz, then dial. Two or three rehearsals are normal.

```bash
curl -sS --max-time 120 -w '\n%{http_code}\n' -X POST "$SWITCHBOARD_URL/mission/rehearse" \
  -H "Authorization: Bearer $SWITCHBOARD_MISSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"keyword":"turkey","name":"Dad","turns":16,
       "callee":"<who answers, two sentences>",
       "scenario":"<the cover story, one paragraph>"}'
```

A mission call lasts up to five minutes
and the score comes two minutes after at most, so the wait is long:

```bash
curl -sS --max-time 480 -w '\n%{http_code}\n' -X POST "$SWITCHBOARD_URL/mission" \
  -H "Authorization: Bearer $SWITCHBOARD_MISSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"target":"dad","keyword":"turkey","name":"Dad","wait":true,
       "scenario":"<the cover story, one paragraph>"}'
```

- `200` with `result`: report it as a story. `won`, `secondsToWin` and
  `winningLine` come from the transcript; `agentSaidFirst` means the caller
  said the word first. Read `transcript` yourself and judge fair play: the
  caller must never have said, spelled, rhymed or hinted the word's letters,
  and the call should read as a call, not a quiz. Quote the two or three
  best lines; never paste the whole transcript into a channel.
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
