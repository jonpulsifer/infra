# smiirl

smiirl is a Go service that answers as `api.smiirl.com`, so the Smiirl
split-flap counter (firmware `smiirl-2.0.7-1`) runs without Smiirl's cloud. Its
web page sets what the counter shows. The product page is
[Smiirl counter](https://wiki.lolwtf.ca/apps/smiirl/), and the operator
procedures are in
[Operate the Smiirl counter](https://wiki.lolwtf.ca/runbooks/operate-the-smiirl-counter/).

## Run

```bash
go build -o smiirl .
mkdir -p /tmp/smiirl
SMIIRL_DATA_DIR=/tmp/smiirl ./smiirl
```

Then, from another shell:

```bash
curl -X PUT localhost:8080/api/number -d '{"number":302}'
curl -X PUT localhost:8080/api/mode -d '{"mode":"clock","hour12":true}'
curl localhost:8080/api/state
curl -H 'Host: api.smiirl.com' localhost:8080/v1.0/aabbccddeeff/00
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `SMIIRL_DATA_DIR` | `/data` | Directory that holds `number.json`. It must exist. |
| `TZ` | `Canada/Atlantic` | Time zone for the daily step (a fixed amount added to the number once a day) and every mode that reads a date or time |
| `SMIIRL_DEVICE_HOST` | `api.smiirl.com` | Host name on which the app answers as the cloud |
| `SMIIRL_VICTORIALOGS_URL` | `http://victoria-logs-server.monitoring.svc.cluster.local:9428` | VictoriaLogs endpoint the `robocalls` mode queries |

## Test

```bash
go test -race ./...
```

`-race` needs a C toolchain. `.github/workflows/go.yml` runs `go build`,
`go vet` and `go test -race` on every change under `apps/smiirl/`.

## Build and deploy

`Dockerfile` builds a static binary on a distroless base.
`.github/workflows/containers.yml` publishes `ghcr.io/jonpulsifer/smiirl`, and
`.github/containers.json` maps the image to
`clusters/folly/apps/smiirl/02-deployment.yaml`, so a build on `main` opens a
pull request that bumps the pinned digest. Flux applies
`clusters/folly/apps/smiirl/` on merge.

## Display

The counter has five drums of twelve flaps: the digits, a blank flap and a
striped flap. A display value is five cells, left to right. Each cell is a
digit, `a` (blank) or `b` (striped). A number is right-aligned with leading
blanks: 302 is `aa302` and 0 is `aaaa0`.

Cells that are leading blanks and then digits with no leading zero are a plain
number, and the firmware gets `{"number":302}`. Other cells go as a string,
`{"number":"14b30"}`.

The counter turns the drums one full revolution for every change, whatever its
size: `11112` to `11113` costs the same turn as `11112` to `40000`. `tick`
limits `clock`, `countdown` and `countup` to one change every N minutes. It is
1 by default.

| Mode | Display |
| --- | --- |
| `number` | The stored cells |
| `clock` | Local time as `HHbMM`, 24-hour and zero-padded (`09b05`), or 12-hour with a blank in place of the leading zero (`a9b05`) when `hour12` is on. With `hour12`, midnight and noon are `12b00`. |
| `date` | Today as `MMbDD` |
| `days` | Calendar days between today and a date, right-aligned and clamped to 99999. The label is `until`, `since` or `today`. Days count on local dates, so a DST change never gives a 23-hour day. |
| `countdown` | Time left until the `countdown` moment as `HHbMM`, at most `99b59`. It stays at `00b00` after the moment. |
| `countup` | Time since the `countup` moment as `HHbMM`. It stops at `99b59`, about four days after the moment. |
| `github` | Public commits or pull requests of a GitHub login, from the unauthenticated search API, fetched at most every 5 minutes. Until the first count arrives, the drums show the stored number. A failed fetch keeps the last count and sets `github.error`. |
| `robocalls` | Calls the PBX screened since midnight in `TZ`, from a LogsQL count over VictoriaLogs, fetched at most every minute. Until the first count arrives, the drums show the stored number. A failed fetch keeps the last count and sets `robocalls.error`. |
| `cycle` | Each mode in `modes` in turn, `every` minutes each (1 to 1440, default 5). It skips a mode that has no settings, and it needs at least two modes it can show. |

The stored number continues in every mode. `/api/number` edits it, and the
daily step changes it while another mode shows. A new value or setting ends a
long poll early. A long poll also checks each second whether the display value
changed, for example at each new minute in `clock` mode.

The daily step adds `step` to the number once a day at `at`, in `TZ`, clamped to
`0..99999`. The check runs at startup and every 30 seconds. Missed days apply
together, up to 366. A day whose cells are not a plain number is skipped and
still marked done. A `step` of 0 turns the step off.

## State

State is `number.json` in `SMIIRL_DATA_DIR`, written to a temp file and renamed.
A missing file, or one that is not valid JSON, starts at 0. Any other read error
stops the app at startup. A file that holds only `{"number":N}` loads as that
number. A file with no `mode`, or with `days` and no valid `daysDate`, loads in
`number` mode.

The Deployment runs one replica with the `Recreate` strategy, because two pods
would race the rename.

## Device API

The firmware speaks plain HTTP to `api.smiirl.com` with
`User-Agent: ESP32 HTTP Client/1.0`. On that host name the app answers as the
cloud and does not serve the page or `/api`.

- `GET /` is `{"smiirl":"api"}`.
- A path that the app does not know, or one under `/api/`, is a 200
  `{"api":"front"}`.
- `GET /number` is `{"number":1}`, with `Content-Length: 12` and no trailing
  newline. The firmware runs this check after it joins Wi-Fi, compares the
  body byte for byte, and opens its setup wizard on any difference.
- `GET /v1.0/register/<mac>` returns `{"result":true}`.
- `GET /v1.0/recover/<code>/<mac>` returns
  `{"result":true,"recovery":true,"id":<mac>,"token":<hex>}`.
- `GET /v1.0/<mac>/<key>` is the bootstrap document. Its `url` is the poll URL
  on the request's `Host`, and its `interval` is 20 (seconds).
- `POST /v1.0/<mac>/<key>/status` returns the bootstrap document with
  `"status":true`, and `/api/state` shows the posted body as
  `device.lastStatus`.
- `GET /<mac>/number` is the long poll. It returns `{"number":N}` or
  `{"number":"<cells>"}` for the current display value.

The app holds a long poll for up to 12 seconds and answers early when the
display value changes. It sends two different values at least 10 seconds apart.
A value that arrives while a drum turns leaves the drums at a fixed offset from
the firmware.

## Page API

- `GET /api/state` returns the state, for example:

  ```json
  {
    "cells": "aa302",
    "number": 302,
    "updatedAt": "2026-09-24T12:00:00Z",
    "mode": "number",
    "display": "aa302",
    "showing": "number",
    "tick": 1,
    "clock": {"cells": "09b05", "hour12": false},
    "date": {"cells": "09b24"},
    "days": {"date": "", "days": null, "label": null},
    "countdown": {"at": "", "left": null},
    "countup": {"at": "2026-09-20T08:00", "elapsed": 5825},
    "github": {"user": "", "what": "commits", "count": 0, "at": null, "error": null},
    "robocalls": {"count": 0, "at": null, "error": null},
    "cycle": {"modes": [], "every": 5},
    "daily": {"step": 1, "at": "08:00", "next": "2026-09-25T08:00:00-03:00"},
    "device": {
      "lastPoll": "2026-09-24T12:05:00Z",
      "lastStatus": {"eth": "", "wlan": "<counter-ip>", "version": "smiirl-2.0.7-1", "counter_type": "esp32"},
      "online": true,
      "lastSent": "aa302",
      "lastSentAt": "2026-09-24T12:00:01Z"
    }
  }
  ```

  - `cells` and `number` are the stored number. `number` is `null` when the
    cells are not a plain number.
  - `display` is what the drums show now. `showing` is the mode on the drums
    now. In `cycle` mode it differs from `mode`.
  - `countdown.left` and `countup.elapsed` are minutes.
  - `days.days` and `days.label` are `null` until a date is set, and
    `github.at` and `robocalls.at` are `null` until the first fetch. `daily.next`
    is `null` when the daily step is off.
  - `device.online` is `true` when the counter polled in the last 60 seconds.
    `device.lastSent` is the value the counter received last. It differs from
    `display` while a change waits for the 10-second gap.
- `PUT /api/number` (or `POST`) takes `{"number":N}` with `N` in `0..99999`, or
  `{"cells":"xxxxx"}`. It returns `{"cells","number"}`.
- `PUT /api/daily` (or `POST`) takes `{"step":N,"at":"HH:MM"}` with `N` in
  `-99999..99999`. The first step applies at the next `at` after the call.
- `PUT /api/mode` (or `POST`) takes `{"mode":"..."}` and the settings of that
  mode:
  - `days`: `"date":"YYYY-MM-DD"`
  - `countdown` and `countup`: `"at":"YYYY-MM-DDTHH:MM"`, read in `TZ`
  - `github`: `"user"` and `"what":"commits"|"prs"`
  - `cycle`: `"modes":[...]` and optionally `"every":N`
  - any mode: `"hour12":true|false` and `"tick":N` (1 to 60 minutes)

  It returns the mode fields of `/api/state`. An unknown mode, a bad setting,
  or a cycle with fewer than two modes it can show is a 400 `{"error"}`.
- `GET /` is the page. `GET /manifest.webmanifest`, `GET /sw.js`,
  `GET /icon.svg` and `GET /icon.png` make it a progressive web app (PWA) that
  installs to a home screen and opens offline. The service worker caches the
  page and never `/api`. `icon.go` draws `icon.png` at startup.
- `GET /healthz` returns `ok`. It takes no lock, so it answers while a write to
  the data volume blocks every other route that reads state.
