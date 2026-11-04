#!/bin/bash
# Makes the capture NIC a listener and nothing else. The mirror port copies
# the uplink's frames, router advertisements among them, and the kernel would
# autoconfigure an IPv6 address and an on-link route through a port that
# forwards nothing. Runs as a privileged init container, which can write the
# node's sysctls.
set -eu
interface=$(/scripts/sensor-interface.sh)
echo 1 >"/proc/sys/net/ipv6/conf/$interface/disable_ipv6"
echo 0 >"/proc/sys/net/ipv6/conf/$interface/accept_ra"
ip -4 addr flush dev "$interface"
ip link set dev "$interface" arp off up promisc on
echo "sensor: $interface is up, promiscuous, with no address" >&2
