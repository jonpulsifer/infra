{ ... }:
{
  # iperf3 target for netbench on bare hosts. Kubernetes nodes already bind port 5201 through the
  # iperf3 DaemonSet in clusters/base/apps/iperf3, so do not import this there.
  services.iperf3 = {
    enable = true;
    openFirewall = true; # LAN-only hosts; exposes tcp/udp 5201
  };
}
