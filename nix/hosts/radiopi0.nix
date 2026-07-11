{
  lib,
  pkgs,
  name,
  ...
}:
{
  imports = [
    ../hardware/pi0.nix
    ../system/nixos.nix
    ../system/tailscale.nix
  ];

  networking = {
    hostName = name;
    wireless = {
      enable = true;
      networks.lab.hidden = true;
    };
  };

  # No armv6l builder or cache exists anywhere -- generations are always
  # cross-built elsewhere (spore) and pushed via `nixos-rebuild --target-host`,
  # never attempted on-device.
  system.autoUpgrade.enable = false;

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
