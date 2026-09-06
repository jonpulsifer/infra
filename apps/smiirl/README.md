# smiirl

A stand-in for `api.smiirl.com` so the Smiirl flip counter (firmware
`smiirl-2.0.7-1`) on the iot VLAN runs without Smiirl's cloud. The lab CoreDNS
(`nix/services/coredns-sinkhole.nix`) resolves `api.smiirl.com` to this
service's Gateway address; the counter polls it over plain HTTP and shows
whatever number the web page last set.

## How it works

- The firmware bootstraps with `GET /v1.0/<mac>/<key>`, reports itself with
  `POST /v1.0/<mac>/<key>/status`, then polls `GET /<mac>/number` roughly every
  20 seconds. The poll is held for up to 12 seconds and answered early when the
  number changes (or at once when it changed between polls), so a new value
  reaches the flaps within a couple of seconds.
- The number lives in `number.json` under `SMIIRL_DATA_DIR`, written as a temp
  file plus rename so a crash mid-write never leaves a torn file. A missing or
  unreadable file starts the counter at 0.
- Every poll stamps the device's last-seen time; `/api/state` reports the
  device `online` when it polled within the last 60 seconds.

### Configuration

| env var           | default | meaning                          |
| ----------------- | ------- | -------------------------------- |
| `PORT`            | `8080`  | listen port                      |
| `SMIIRL_DATA_DIR` | `/data` | directory holding `number.json`  |

### Device API (what the firmware calls)

- `GET /v1.0/<mac>/<key>` — bootstrap; the poll URL echoes the request's `Host`
- `POST /v1.0/<mac>/<key>/status` — acknowledged with `{"result":true}`
- `GET /<mac>/number` — long-poll, `{"number":N}`

### UI API

- `GET /api/state` — `{"number","updatedAt","device":{"lastPoll","lastStatus","online"}}`
- `PUT /api/number` (or `POST`) — body `{"number":N}`, `N` in `0..99999`
- `GET /` — the embedded page
- `GET /healthz`

## Local development

```bash
go build -o smiirl .
SMIIRL_DATA_DIR=/tmp/smiirl ./smiirl
curl -X PUT localhost:8080/api/number -d '{"number":302}'
curl -H 'Host: api.smiirl.com' localhost:8080/v1.0/aabbccddeeff/00
```

## Deploy

GitOps via Flux: `clusters/folly/apps/smiirl`. The image is published by
`.github/workflows/containers.yml` (registered in `.github/containers.json`).
