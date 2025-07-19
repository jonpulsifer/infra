{
  config,
  lib,
  name,
  ...
}:
with lib;
{
  users.users = {
    # Remove initialHashedPassword for root and nixos
    root.initialHashedPassword = mkForce null;
    nixos.initialHashedPassword = mkForce null;
    jawn.extraGroups = [
      "video"
      "networkmanager"
    ];
  };

  networking.useDHCP = mkForce true;
  networking.useNetworkd = mkForce true;
  networking.networkmanager.enable = mkForce false;

  networking.hostName = "nixos-iso";
  networking.wireless.enable = true;

  # why is this a thing that exists
  services.openssh.settings.PermitRootLogin = mkForce "no";

  # auto log me in
  services.getty.autologinUser = mkForce config.users.users.jawn.name;
}
