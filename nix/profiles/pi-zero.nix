# Raspberry Pi Zero W (armv6l).
#
# No armv6l builder or binary cache exists, so these are cross-compiled on forge
# (nix/hardware/pi0.nix sets nixpkgs.crossSystem) and generations are pushed with
# `nixos-rebuild --target-host` rather than built on-device.
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

    # The rest of the fleet runs systemd-networkd, which the baseline defaults
    # on. These two are still on the scripted dhcpcd path and there is no
    # console to recover from if the wireless interface comes up differently --
    # migrate them deliberately, not as a side effect of inheriting a baseline.
    useNetworkd = false;
  };

  system.autoUpgrade.enable = false;

  # Everything here would have to be cross-compiled onto a single-core board
  # with nothing to pull from: mise publishes no armv6l binary at all, and the
  # node exporter, full terminfo database, and home-manager's shell-tool suite
  # (btop, neovim, fzf, ...) are pure cost on a host whose job is to drive one
  # radio.
  homelab.fleet = {
    miseDotfiles = false;
    homeManager = false;
    metrics = false;
    terminfo = false;
  };

  # mise (from system/user.nix) has no armv6l-linux release; keep the rest of
  # the default user package set, drop just that.
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
