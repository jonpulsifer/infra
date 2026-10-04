# flameboss

flameboss is a Prometheus exporter for a Flame Boss barbecue controller, and a
[Pixlet][pixlet] app, `flameboss.star`, that shows the cook on the
[Tronbyt][tronbyt]. The exporter reads the controller from the Flame Boss cloud
MQTT brokers and never sends it a command. See
[Flame Boss exporter](https://wiki.lolwtf.ca/apps/flameboss/),
[Tidbyt apps](https://wiki.lolwtf.ca/apps/tidbyt/) and
[Operate the Flame Boss exporter](https://wiki.lolwtf.ca/runbooks/operate-the-flame-boss-exporter/).

## Run

```bash
FLAMEBOSS_USERNAME=T-000000 FLAMEBOSS_PASSWORD=… go run .
curl -s localhost:8080/metrics | grep flameboss_
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLAMEBOSS_USERNAME` | none | `T-<user_id>`. The exporter reads the account id from it. |
| `FLAMEBOSS_PASSWORD` | none | The token from <https://myflameboss.com/users/dev> |
| `FLAMEBOSS_HOST` | `myflameboss.com` | The entry host |
| `FLAMEBOSS_PORT` | `8883` | |
| `FLAMEBOSS_TLS` | on | `false` for a plaintext broker or a simulator |
| `FLAMEBOSS_LISTEN` | `:8080` | Serves `/metrics`, `/api/cook` and `/healthz` |
| `FLAMEBOSS_STALE_AFTER` | `5m` | Silence that sets `flameboss_cook_active` to 0 |
| `FLAMEBOSS_RETIRE_AFTER` | `30m` | Silence that removes the series and the `/api/cook` entry of the cook |
| `FLAMEBOSS_ANNOUNCE_EVERY` | `15m` | The interval between announcements |
| `LOG_LEVEL` | `info` | `debug` logs each uplink |

## Protocol

[fb-api-doc](https://github.com/flameboss/fb-api-doc) is the upstream
description. The exporter depends on these behaviors:

1. A client connects to `myflameboss.com:8883`, a load balancer in front of
   several servers. A controller can move between servers.
2. The client subscribes to `user/<user_id>/recv` and publishes
   `{"name":"connected"}` to `user/<user_id>/send`.
3. The control plane replies with one `connected` message for the connection,
   and one for each online controller that names its server. The exporter
   follows each controller to its server.
4. The client subscribes to `flameboss/<device_id>/send/open` and
   `flameboss/<device_id>/send/data` by name. The broker accepts a `send/#`
   wildcard and delivers nothing to it.

Wire values are decidegrees Celsius, whatever the controller shows. `-32767` is
an unplugged probe. `blower` is in hundredths of a percent. `temps[0]` is the
pit, and `temps[1..3]` are the meat probes. `send/data` carries settings and
events. The controller sends one when it changes, and all of them when it
reconnects.

## Metrics

`state.go` defines each metric and its help text. Temperatures are in
Fahrenheit. `evidence` in `relay.go` lists the uplinks whose format is not
known. The exporter logs the first payload of each one (`"msg":"first uplink"`).
The list is an allow-list, because the `wifi` uplink carries the SSID and can
carry the Wi-Fi key.

## Cook snapshot

`GET /api/cook` serves one JSON snapshot of every controller the exporter
knows, computed at request time. `flameboss.star` in this directory reads it.
`api.go` holds the handler and the document, and its json tags are the
contract. Each device carries `id`, `online` and a `cook`, which is `null` when
no cook is running or the cook has retired.

A live cook has the current pit, set and probe temperatures in Fahrenheit to
0.1, the blower and the lid. It has the seconds since the controller's own
alarms fired and a `history` of the temperatures from the start of the cook. A
temperature is `null` when its probe is unplugged or the bucket has no
reading. An alarm setting or event time is `null` until the controller reports
it. An unnamed probe's `label` is `""`.

`history.go` keeps that record. Its buckets are `step_seconds` wide, starting
at 60 s. The step doubles whenever the cook would pass 240 buckets, so the
record stays bounded. A bucket holds the last reading in it, and doubling the
step keeps the later bucket of each pair that has a reading. The last bucket is
the present, and a quiet controller shows trailing nulls. The endpoint answers
`GET` only.

## Tidbyt app

![flameboss](./flameboss.webp)

![flameboss @2x](./flameboss@2x.webp)

Render the app against `sample_results.json`, a cook five hours in with two meat
probes. `mise install` at the repo root supplies `pixlet`.

```bash
python3 -m http.server 8000 &
pixlet render flameboss.star api_url=http://127.0.0.1:8000/sample_results.json --format gif -o preview.gif
pixlet render -2 flameboss.star api_url=http://127.0.0.1:8000/sample_results.json --format gif -o preview@2x.gif
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `api_url` | `http://flameboss.monitoring:8080/api/cook` | The exporter's `/api/cook` endpoint |
| `units` | `F` | `F` or `C`, the unit of the temperatures on screen |
| `done_f` | `203` | The meat temperature in Fahrenheit that calls PULL IT |
| `wrap_f` | `165` | The wrap point in Fahrenheit |
| `show_idle` | off | Draws an idle page when no cook is running |
| `device` | blank | A Flame Boss device id. Blank follows the controller cooking, and an active cook beats a quiet one. |

The fire page shows the pit over a fire that follows the blower. The meat page
walks each probe toward `done_f` past `wrap_f`, and the chart page graphs the
cook. Alert pages take over the rotation. LID OPEN, the controller's own pit
alarm and vent advice, GONE QUIET and CLOUD DOWN show at once. PIT LOW, PIT
HIGH, ADD FUEL and PIT PROBE UNPLUGGED wait for the history. They show once it
holds the condition for the `for` window of the matching rule in
`clusters/folly/monitoring/flameboss-rules.yaml`. A cook with a shorter history
shows none of them. A rotation has at most two alert pages, and PULL IT,
which a probe at `done_f` calls, always keeps one of them. With no cook, or a
`device` the exporter has not seen, the app returns `[]` and Tronbyt skips it.
The `show_idle` setting draws the idle page instead.

The Tronbyt server in `clusters/folly/apps/tronbyt/` runs the app, and no
manifest in git installs `flameboss.star` on it.
`.github/workflows/pixlet-preview.yml` renders a changed `flameboss.star` on the
pull request.

## Test and deploy

```bash
go test -race ./...
```

`-race` needs a C toolchain. `.github/workflows/go.yml` runs `go build`,
`go vet` and `go test -race` on each change under `apps/flameboss/`.

`.github/workflows/containers.yml` publishes `ghcr.io/jonpulsifer/flameboss`.
Flux applies `clusters/folly/monitoring/flameboss.yaml`, the alerts in
`clusters/folly/monitoring/flameboss-rules.yaml` and the dashboard
`clusters/folly/monitoring/grafana-dashboards/flameboss.json`.

[tronbyt]: https://github.com/tronbyt/tronbyt-server
[pixlet]: https://github.com/tronbyt/pixlet
