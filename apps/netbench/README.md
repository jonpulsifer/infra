# netbench

A small web UI for running [`iperf3`](https://iperf.fr/) throughput/latency
tests across the homelab and rendering the results. It exists to answer "how
fast / how lossy is *this* network path" along three axes:

| category        | path under test                                   | where the server runs                          |
| --------------- | ------------------------------------------------- | ---------------------------------------------- |
| `node`          | pod → in-cluster node (inter-node fabric / wire)  | `iperf3` DaemonSet (`clusters/base/apps/iperf3`) |
| `lan`           | pod → bare host on another VLAN (inter-LAN)       | NixOS `services.iperf3` (`nix/services/iperf3.nix`) |
| `cross-cluster` | pod → remote cluster over the Site Magic tunnel   | the same DaemonSet, running on offsite nodes   |

> `iperf3` measures the **transport layer** (bandwidth, jitter, loss,
> retransmits). For **application-layer** load testing (req/s, p95 latency)
> use the k6-operator already deployed in `clusters/folly/apps/k6`.

## How it works

- `netbench` serves a web UI and a tiny JSON API. The browser sends only a
  target **name**; the server maps that to a host/port from its config and
  shells out to `iperf3 -c <host> -J`, so a client can never aim iperf3 at an
  arbitrary host.
- Targets are loaded from a JSON file (`NETBENCH_TARGETS_FILE`, default
  `/etc/netbench/targets.json`) — in-cluster this is a ConfigMap. See
  [`targets.example.json`](./targets.example.json).

### Configuration

| env var                 | default                       | meaning                          |
| ----------------------- | ----------------------------- | -------------------------------- |
| `NETBENCH_ADDR`         | `:8080`                       | listen address                   |
| `NETBENCH_TARGETS_FILE` | `/etc/netbench/targets.json`  | path to the targets JSON file    |

### API

- `GET /api/targets` — configured targets
- `POST /api/run` — body `{"target","duration","protocol":"tcp|udp","reverse","parallel"}` → result summary
- `GET /healthz`

## Local development

```bash
go build -o netbench .
NETBENCH_TARGETS_FILE=./targets.example.json ./netbench
# open http://localhost:8080  (needs iperf3 on PATH and reachable servers)
```

## Deploy

GitOps via Flux. The web UI is `clusters/folly/apps/netbench`; the per-node
iperf3 servers are the shared `clusters/base/apps/iperf3` DaemonSet referenced
from both clusters. The image is published by `.github/workflows/containers.yml`
(registered in `.github/containers.json`).
