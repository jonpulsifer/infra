{ ... }:
{
  # iperf3 server for netbench's inter-LAN benchmarks (see apps/netbench and
  # clusters/folly/apps/netbench). Import this on bare hosts that should be
  # reachable as benchmark targets.
  #
  # Do NOT import on Kubernetes nodes: they already run the hostNetwork iperf3
  # DaemonSet (clusters/base/apps/iperf3) bound to the same port 5201, which
  # would conflict.
  services.iperf3 = {
    enable = true;
    openFirewall = true; # LAN-only hosts; exposes tcp/udp 5201
  };
}
