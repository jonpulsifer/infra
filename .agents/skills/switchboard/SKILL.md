---
name: switchboard
description: >-
  Ring the owner's phone through switchboard from a Rowbutt sandbox. Use when
  the owner asks to be called, rung or phoned, or says "call me".
metadata:
  runbook: docs/apps/switchboard.md
  wiki: https://wiki.lolwtf.ca/apps/switchboard/
---

# Switchboard

The service page is `docs/apps/switchboard.md`. These notes cover what an
agent needs beyond it.

## Ring

When the owner asks to be called, send one request and read the status code:

```bash
curl -sS --max-time 15 -w '\n%{http_code}\n' -X POST "$SWITCHBOARD_URL/ring" \
  -H "Authorization: Bearer $SWITCHBOARD_RING_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"<one short line>"}'
```

- `200`: the call is placed. Say so.
- `429`: refused. The body's `skipped` field says why, `daily-cap` or
  `cooldown`. Report the reason and do not retry.
- `502`: the call was attempted once and failed. Report it and do not retry.
- `401`, or either variable unset: this sandbox has no ring token. Say so.
- `000`, with a curl error instead of a response (name not resolved,
  connection refused, or the timeout): switchboard is parked, as
  `docs/apps/switchboard.md` says. Say so and do not retry.

## Notes

- The number is fixed on the server, and no request can choose another. There
  is no other way to place a call: no PBX, no ElevenLabs API, no voip.ms.
- The reason is one line the agent on the call reads to the owner. Keep it
  short, with no secret in it. Print only the body and the status code; the
  token never goes in a message or a log.
