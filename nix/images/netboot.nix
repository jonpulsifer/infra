{
  config,
  lib,
  name ? "k8s-node",
  tags ? [ "folly" ],
  modulesPath,
  ...
}:
{
  imports = [
    (modulesPath + "/installer/netboot/netboot-minimal.nix")
    ../profiles/k8s-node.nix
  ];

  networking.hostName = name;

  users.users = {
    # Remove initialHashedPassword for root and nixos
    root.initialHashedPassword = lib.mkForce null;
    nixos.initialHashedPassword = lib.mkForce null;
  };

  networking.useDHCP = lib.mkForce true;
  networking.useNetworkd = lib.mkForce true;
  networking.networkmanager.enable = lib.mkForce false;
  networking.wireless.enable = false;

  # why is this a thing that exists
  services.openssh.settings.PermitRootLogin = lib.mkForce "no";

  # auto log me in
  services.getty.autologinUser = lib.mkForce config.users.users.jawn.name;
}
