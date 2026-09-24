# Raspberry Pi Zero W (armv6l). No armv6l binary cache exists, so the closure cross-compiles
# from aarch64-linux (nix/hardware/pi0.nix) and is never built on the device.
{
  lib,
  pkgs,
  ...
}:
{
  imports = [ ../hardware/pi0.nix ];

  networking = {
    wireless = {
      enable = true;
      networks.lab.hidden = true;
    };

    # The baseline defaults networkd on. These stay on scripted dhcpcd: if wireless comes up
    # differently, there is no console to recover from.
    useNetworkd = false;
  };

  system.autoUpgrade.enable = false;

  # Each of these would cross-compile from source for a single-purpose board, and mise has no
  # armv6l release.
  homelab.fleet = {
    miseDotfiles = false;
    homeManager = false;
    metrics = false;
    terminfo = false;
  };

  users.users.jawn.packages = lib.mkForce (
    with pkgs;
    [
      git
      unzip
      gnupg
    ]
  );
  users.users.rowbutt.packages = lib.mkForce (
    with pkgs;
    [
      git
      unzip
      gnupg
    ]
  );
}
