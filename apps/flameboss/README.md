# flameboss

flameboss is a Prometheus exporter for a Flame Boss barbecue controller. It
reads the controller from the Flame Boss cloud MQTT brokers and never sends it a
command. See [Flame Boss exporter](https://wiki.lolwtf.ca/apps/flameboss/) and
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
| `FLAMEBOSS_LISTEN` | `:8080` | Serves `/metrics` and `/healthz` |
| `FLAMEBOSS_STALE_AFTER` | `5m` | Silence that sets `flameboss_cook_active` to 0 |
| `FLAMEBOSS_RETIRE_AFTER` | `30m` | Silence that removes the series of the cook |
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
