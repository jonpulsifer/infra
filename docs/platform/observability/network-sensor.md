---
title: Network sensor
description: Zeek and Suricata on a folly node read a copy of the gateway uplink's traffic from a switch mirror port and log to VictoriaLogs.
---

The network sensor is Zeek and Suricata on shale, a folly [Kubernetes](../kubernetes.md) node. The switch copies every frame that crosses its uplink to the gateway onto a mirror port, and a USB NIC on shale reads that copy. Zeek writes a record of each connection and protocol transaction, and Suricata matches the traffic against the ET Open rules and writes alerts. Both log to VictoriaLogs, so the owner queries them in Grafana.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Mirror port | Copies the uplink's frames, both directions, onto the sensor port, and forwards nothing | The USW 24 PoE switch, `terraform/network/unifi/folly/bootstrap.tf` |
| Zeek | Logs connections and protocols as JSON on stdout, one stream name in `_path` | The `zeek` Deployment in `clusters/folly/apps/sensor/` |
| Suricata | Matches the ET Open rules and writes EVE JSON on stdout; a sidecar refreshes the rules each day | The `suricata` Deployment in `clusters/folly/apps/sensor/` |
| Vector | Ships both pods' stdout to VictoriaLogs | Each node, [Observability](../observability.md) |

## Use it

Query VictoriaLogs in Grafana with the `kubernetes` job and the `sensor` namespace. The `container` label tells `zeek` from `suricata`. Each record carries a community ID, so a Zeek connection and a Suricata alert on the same flow share one.

## Limits

- The sensor sees traffic that crosses the uplink: everything to and from the internet, and between the networks the gateway routes. Traffic between two ports of the switch, such as two nodes, stays off the uplink.
- A mirror copies both directions of a gigabit link onto one gigabit port, so the sensor port drops frames when the uplink runs above half its rate.
- Both pods wait, and log that they wait, until a USB NIC is plugged into shale. They find the NIC by its USB bus, so its name does not matter.
- Talos ships only the Realtek and Microchip USB NIC drivers. The ASIX AX88179 driver comes from the `usb-modem-drivers` extension in `clusters/folly/talos/talos.tf`, and the worker-g2 class patch in `clusters/folly/talos/talos.tf` loads it, because fleetd renders a node's config by its class.
- The NIC carries no address. Each pod's init container turns IPv6 off on it, flushes it and sets it promiscuous, because the kernel would otherwise autoconfigure an address and an on-link route from a mirrored router advertisement, through a port that forwards nothing.

## How it works

The switch port that `sensor_port` names in `bootstrap.tf` is in mirror mode with the uplink as its source. Each pod shares shale's network namespace and has the capabilities to bring the NIC up in promiscuous mode and open packet sockets. `clusters/folly/apps/sensor/scripts/sensor-interface.sh` finds the link whose device path runs through a USB bus. `clusters/folly/apps/sensor/scripts/sensor.zeek` turns every Zeek stream into JSON on stdout with the stream's name in `_path`. Suricata runs the image's default configuration with EVE on stdout, and `suricata-update` fetches the rules before it starts.

## Where it lives

- `clusters/folly/apps/sensor/`: the namespace, both Deployments and the scripts
- `terraform/network/unifi/folly/bootstrap.tf`: the `uplink_port` and `sensor_port` locals and the mirror port
- [shale](../../hosts/shale.md): the node with the USB NIC

## Related

- [Observability](../observability.md)
- [Network](../network.md)
