# netbench

netbench is a Go web page that runs [`iperf3`](https://iperf.fr/) tests from the
folly cluster to named targets and shows the results. See
[netbench](https://wiki.lolwtf.ca/apps/netbench/).

## Run

```bash
go build -o netbench .
NETBENCH_TARGETS_FILE=./targets.example.json ./netbench
```

Open http://localhost:8080. A test needs `iperf3` on `PATH` and a target that
answers.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NETBENCH_ADDR` | `:8080` | Listen address |
| `NETBENCH_TARGETS_FILE` | `/etc/netbench/targets.json` | The targets file. `targets.example.json` shows its format. |

The browser sends only a target name. The server finds the host and port in
the targets file and runs `iperf3 -c <host> -J`, so a client cannot aim
`iperf3` at another host.

| Route | Does |
| --- | --- |
| `GET /api/targets` | Lists the targets |
| `POST /api/run` | Runs a test. The body is `{"target","duration","protocol":"tcp\|udp","reverse","parallel"}`. |
| `GET /healthz` | Health check |

The package has no tests.

## Deploy

`.github/workflows/containers.yml` publishes `ghcr.io/jonpulsifer/netbench`.
Flux applies `clusters/folly/apps/netbench/`, where `02-targets.yaml` holds the
targets. The `iperf3` servers are the DaemonSet in `clusters/base/apps/iperf3/`,
which uses the same image, and `nix/services/iperf3.nix` on the hosts.
