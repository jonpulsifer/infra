{
  config,
  lib,
  name,
  modulesPath,
  ...
}:
{
  imports = [
    (modulesPath + "/installer/cd-dvd/installation-cd-minimal.nix")
    ../hardware/x86
    ../profiles/server.nix
  ];

  users.users = {
    # Remove initialHashedPassword for root and nixos
    root.initialHashedPassword = lib.mkForce null;
    nixos.initialHashedPassword = lib.mkForce null;
    jawn.extraGroups = [
      "video"
      "networkmanager"
    ];
  };

  networking.useDHCP = lib.mkForce true;
  networking.useNetworkd = lib.mkForce true;
  networking.networkmanager.enable = lib.mkForce false;

  networking.hostName = "nixos-iso";
  networking.wireless.enable = true;

  # why is this a thing that exists
  services.openssh.settings.PermitRootLogin = lib.mkForce "no";

  # auto log me in
  services.getty.autologinUser = lib.mkForce config.users.users.jawn.name;
}
