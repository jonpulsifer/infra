{
  config,
  lib,
  modulesPath,
  ...
}:
{
  imports = [
    (modulesPath + "/installer/netboot/netboot-minimal.nix")
    ../hardware/x86
    ../services/common.nix
  ];

  users.users = {
    # Remove initialHashedPassword for root and nixos
    root.initialHashedPassword = lib.mkForce null;
    nixos.initialHashedPassword = lib.mkForce null;
  };

  networking.useDHCP = lib.mkForce true;
  networking.useNetworkd = lib.mkForce true;
  networking.networkmanager.enable = lib.mkForce false;

  networking.hostName = "nixos-netboot";
  networking.wireless.enable = true;

  # why is this a thing that exists
  services.openssh.settings.PermitRootLogin = lib.mkForce "no";

  # auto log me in
  services.getty.autologinUser = lib.mkForce config.users.users.jawn.name;
}
