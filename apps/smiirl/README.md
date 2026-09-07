# smiirl

A stand-in for `api.smiirl.com` so the Smiirl flip counter (firmware
`smiirl-2.0.7-1`) on the iot VLAN runs without Smiirl's cloud. The lab CoreDNS
(`nix/services/coredns-sinkhole.nix`) resolves `api.smiirl.com`, and the page's
`counter.<zone>` / `smiirl.<zone>` names, to this service's Gateway address;
the counter polls it over plain HTTP and shows whatever the web page last set.

## How it works

- The counter has five drums of twelve flaps each: the digits, a blank and a
  striped flap. A display value is five **cells** over `0-9`, `a` (blank) and
  `b` (striped), left to right. A number is right-aligned with leading blanks,
  the way the real counter shows it: 302 is `aa302`, 0 is `aaaa0`.
- Cells that are leading blanks followed by digits with no leading zero are a
  plain number, and the firmware is told `{"number":302}`. Anything else
  (striped flaps, embedded or trailing blanks, explicit leading zeros) has no
  number and the firmware is told the raw cells as a string, `{"number":"14b30"}`,
  which is how the cloud addresses individual flaps.
- The firmware bootstraps with `GET /v1.0/<mac>/<key>`, reports itself with
  `POST /v1.0/<mac>/<key>/status`, then polls `GET /<mac>/number` roughly every
  20 seconds. The poll is held for up to 12 seconds and answered early when the
  cells change (or at once when they changed between polls), so a new value
  reaches the flaps within a couple of seconds. Two different values are never
  handed to the device less than 10 seconds apart: a drum needs a few seconds
  per flip and a full turn to reach a lower digit, and a value arriving
  mid-turn leaves drums out of step until the counter is power-cycled.
- On the device's hostname (`SMIIRL_DEVICE_HOST`, `api.smiirl.com` by default)
  the app answers like the cloud: `GET /` is `{"smiirl":"api"}`, `GET /number`
  is `{"number":1}` (the firmware's internet check after it joins Wi-Fi; it
  gives up and falls back to setup mode without it), and any other path is a
  200 `{"api":"front"}`. The page and its `/api` are not offered on that name.
- The counter shows one of three **modes**. `number` shows the stored cells.
  `clock` shows the local time in `TZ` as `HHbMM`: hours, the striped flap as
  the separator, minutes, 24-hour and zero-padded (`09b05`, `14b30`), or
  12-hour with the leading zero as a blank flap (`a9b05`, `a2b30`) when
  `hour12` is on — midnight and noon are `12b00`, and no drum shows am/pm.
  `days`
  shows the whole calendar days between today and a date, right-aligned like
  a number and clamped to 99999, labelled `until` when the date is ahead,
  `since` when it is past and `today` when it is today (0). Days are counted
  on local dates, so a DST change never yields a 23-hour day. The stored
  number is kept in every mode: `/api/number` still edits it and the daily
  step still moves it while the clock or a countdown is showing. Switching
  mode wakes the device poll like a new value does, and the poll also checks
  once a second whether the clock or countdown has moved on its own.
- An optional daily step adds `step` to the number once a day at `at`
  (24-hour local time in `TZ`, `Canada/Atlantic` by default), clamped to
  `0..99999`. The check runs at startup and every 30 seconds; days missed while
  the service was down are applied together (up to 366), and a day is skipped
  but still marked done when the cells are not a plain number. `step` of 0
  turns it off.
- State lives in `number.json` under `SMIIRL_DATA_DIR`, written as a temp file
  plus rename so a crash mid-write never leaves a torn file. A missing or
  unreadable file starts the counter at 0; a file from before cells existed
  (`{"number":N}`) loads as that number, and one without a `mode` (or with a
  days mode but no valid `daysDate`) loads in number mode.
- Every poll stamps the device's last-seen time; `/api/state` reports the
  device `online` when it polled within the last 60 seconds.

### Configuration

| env var           | default           | meaning                          |
| ----------------- | ----------------- | -------------------------------- |
| `PORT`            | `8080`            | listen port                      |
| `SMIIRL_DATA_DIR` | `/data`           | directory holding `number.json`  |
| `TZ`              | `Canada/Atlantic` | clock for the daily step, clock mode and day counts |

### Device API (what the firmware calls)

- `GET /v1.0/register/<mac>` — `{"result":true}`
- `GET /v1.0/recover/<code>/<mac>` — `{"result":true,"recovery":true,"id":<mac>,"token":<hex>}`
- `GET /v1.0/<mac>/<key>` — bootstrap; the poll URL echoes the request's `Host`
- `POST /v1.0/<mac>/<key>/status` — the bootstrap document plus `"status":true`
- `GET /<mac>/number` — long-poll, `{"number":N}` or `{"number":"<cells>"}`,
  whatever the current mode displays

### UI API

- `GET /api/state` —
  `{"cells","number","updatedAt","mode","display","clock":{"cells","hour12"},"days":{"date","days","label"},"daily":{"step","at","next"},"device":{"lastPoll","lastStatus","online"}}`;
  `cells`/`number` are the stored number (`number` is `null` when the cells
  are not a plain number), `display` is what the drums show right now,
  `clock.cells` is the time now as `HHbMM` and `clock.hour12` says whether
  the clock is 12-hour, `days.days`/`days.label` are
  `null` until a date is set, `next` is `null` when the daily step is off
- `PUT /api/number` (or `POST`) — body `{"number":N}` with `N` in `0..99999`,
  or `{"cells":"xxxxx"}`; answers `{"cells","number"}`
- `PUT /api/daily` (or `POST`) — body `{"step":N,"at":"HH:MM"}` with `N` in
  `-99999..99999`; the first step lands at the next `at` after the call
- `PUT /api/mode` (or `POST`) — body `{"mode":"number"}`, `{"mode":"clock"}`
  or `{"mode":"days","date":"YYYY-MM-DD"}`, with an optional `"hour12":true`
  alongside `number` or `clock`; answers `{"mode","display","clock","days"}`;
  a days request without a valid date or an unknown mode is a 400
  `{"error"}`. The date and the 12-hour choice stay remembered when switching
  to another mode.
- `GET /` — the embedded page
- `GET /healthz`

## Local development

```bash
go build -o smiirl .
SMIIRL_DATA_DIR=/tmp/smiirl ./smiirl
curl -X PUT localhost:8080/api/number -d '{"number":302}'
curl -X PUT localhost:8080/api/number -d '{"cells":"14b30"}'
curl -X PUT localhost:8080/api/daily -d '{"step":1,"at":"08:00"}'
curl -X PUT localhost:8080/api/mode -d '{"mode":"clock"}'
curl -X PUT localhost:8080/api/mode -d '{"mode":"clock","hour12":true}'
curl -X PUT localhost:8080/api/mode -d '{"mode":"days","date":"2026-12-25"}'
curl -H 'Host: api.smiirl.com' localhost:8080/v1.0/aabbccddeeff/00
```

## Deploy

GitOps via Flux: `clusters/folly/apps/smiirl`. The image is published by
`.github/workflows/containers.yml` (registered in `.github/containers.json`).
