# flameboss

A Prometheus exporter for a Flame Boss barbecue controller.

The controller publishes to Flame Boss's cloud MQTT brokers, not to the lab, so
this is a client of that cloud rather than a scrape of the device. It discovers
the account's controllers, follows each one to whichever server it is currently
on, and exports its readings as series Prometheus can keep and Alertmanager can
read. It subscribes and announces; it never publishes a command to a
controller.

Deployed on folly as `clusters/folly/monitoring/flameboss.yaml`, with its
alerts in `flameboss-rules.yaml` and its dashboard in `grafana-dashboards/`.
Operationally: `docs/apps/flameboss.md`.

## The protocol, as measured

A device is not pinned to a server, and the published host is a load balancer
in front of all of them — which is why a fixed bridge to one server FQDN works
until the device moves and is then silent rather than broken.

1. Connect to `myflameboss.com:8883` with the `T-<user_id>` username and token
   from <https://myflameboss.com/users/dev>.
2. Subscribe `user/<user_id>/recv` and publish `{"name":"connected"}` to
   `user/<user_id>/send`.
3. The control plane replies with a device-less `connected` naming the server
   this connection landed on, then one per online device naming that device's
   server. A device on a server already held is served on that connection.
4. Subscribe `flameboss/<device_id>/send/open` and `.../send/data`
   **explicitly**. A `send/#` wildcard is accepted and delivers nothing.

Telemetry is one message:

```json
{"name":"temps","cook_id":5242100,"sec":1789943581,"temps":[1305,-32767,-32767,-32767],"set_temp":1212,"blower":0}
```

- Temperatures are **decidegrees Celsius** whatever the controller displays:
  `1212` is 121.2 °C, the 250 °F on the front panel.
- `-32767` is a probe that is not plugged in.
- `blower` is hundredths of a percent; `10000` is a fan at full.
- `temps[0]` is the pit, `temps[1..3]` the meat probes.

Upstream's own description of all of this is
<https://github.com/flameboss/fb-api-doc>.

## Metrics

Every temperature is Fahrenheit. A cook's series exist only while the cook
does: five minutes of silence drops `flameboss_cook_active` to 0, and thirty
retires them, so a cold pit never reads as a live cook.

| Metric | |
| --- | --- |
| `flameboss_cook{device,cook_id}` | 1, labelled with the cook being logged |
| `flameboss_cook_active{device}` | 1 while readings are arriving |
| `flameboss_cook_start_timestamp_seconds{device}` | when this process first saw the cook |
| `flameboss_telemetry_timestamp_seconds{device}` | the controller's own timestamp on its last reading |
| `flameboss_pit_temp_fahrenheit{device}` | pit |
| `flameboss_pit_target_fahrenheit{device}` | set temperature |
| `flameboss_pit_reached_target{device}` | 1 once the pit has come within 5 °F of set this cook |
| `flameboss_pit_probe_connected{device}` | 1 when the pit probe is plugged in |
| `flameboss_probe_temp_fahrenheit{device,probe}` | meat probes; unplugged exports no series |
| `flameboss_blower_percent{device}` | fan duty cycle |
| `flameboss_device_online{device}` | what the control plane says |
| `flameboss_device_server{device,server}` | which server it is on |
| `flameboss_messages_total{device,name}` | uplinks by message name |
| `flameboss_broker_connected{server}` | this process's own connections |
| `flameboss_broker_reconnects_total{server}` | |
| `flameboss_probe_info{device,probe,label}` | 1, labelled with the name the controller shows for the probe |
| `flameboss_meat_alarm_enabled{device,probe}` | 1 when a done alarm is set on the controller for the probe |
| `flameboss_pit_alarm_enabled{device}` | 1 when the controller's pit alarm is on |
| `flameboss_supply_volts{device}` | DC input |
| `flameboss_lid_open{device}` | 1 while the controller reports the cooker open |
| `flameboss_meat_alarm_triggered{device,probe}` | 1 once the controller's done alarm fired this cook |
| `flameboss_pit_alarm_triggered_timestamp_seconds{device}` | when the controller's pit alarm last fired this cook |
| `flameboss_vent_advice_timestamp_seconds{device}` | when the controller last advised closing the vent this cook |

The settings (`probe_info`, `*_alarm_enabled`, `supply_volts`) are absent
until the controller publishes them, never a guessed 0. The events belong to a
cook: one that arrives before any `temps` is dropped, and a new `cook_id`
clears them.

### Controller uplinks

`send/data` carries the controller's settings and events. It publishes them
when one changes, and all of them in a burst when it reconnects — so a quiet
`send/data` is a controller with nothing new to say, not a broken
subscription.

`opened`/`closed` are the lid events on this firmware; the spec marks them
deprecated for `open_pit`, but `open_pit` is the lid-pause *setting*.

The temperatures in `meat_alarm` and `pit_alarm` are not exported yet. The
spec's examples for them read as Fahrenheit, and so did its example for
`temps`, which is decidegrees Celsius on the wire. The first `meat_alarm`,
`pit_alarm`, `device_temp`, `dc_input`, `temp_scale`, `disconnected`, `cook`
and `mtemps` payload each process sees is logged whole (`"msg":"first uplink"`)
so a real cook settles their format. The list is an allow-list because `wifi`
carries the network's SSID and may carry its key.

`flameboss_pit_reached_target` is what keeps the band alerts quiet during the
ramp from ambient, which is otherwise every cook's first hour.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `FLAMEBOSS_USERNAME` | — | `T-<user_id>`; the account id is read from it |
| `FLAMEBOSS_PASSWORD` | — | the token from the dev page |
| `FLAMEBOSS_HOST` | `myflameboss.com` | entry host |
| `FLAMEBOSS_PORT` | `8883` | |
| `FLAMEBOSS_TLS` | on | `false` for a plaintext broker or a simulator |
| `FLAMEBOSS_LISTEN` | `:8080` | `/metrics` and `/healthz` |
| `FLAMEBOSS_STALE_AFTER` | `5m` | silence that ends `cook_active` |
| `FLAMEBOSS_RETIRE_AFTER` | `30m` | silence that retires the cook's series |
| `FLAMEBOSS_ANNOUNCE_EVERY` | `15m` | re-announce interval |
| `LOG_LEVEL` | info | `debug` logs every uplink |

```bash
FLAMEBOSS_USERNAME=T-000000 FLAMEBOSS_PASSWORD=… go run .
curl -s localhost:8080/metrics | grep flameboss_
```
