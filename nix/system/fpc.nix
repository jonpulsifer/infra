{ config, pkgs, ... }:
{
  config.boot.kernel.sysctl."net.ipv6.conf.enp0s20f0u2.disable_ipv6" = true;
}
