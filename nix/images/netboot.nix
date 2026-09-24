{
  config,
  lib,
  pkgs,
  modulesPath,
  ...
}:
{
  imports = [
    (modulesPath + "/installer/netboot/netboot-minimal.nix")
    ../hardware/x86
  ];

  # PXE needs all three files, so `artifact` names them as one derivation.
  system.build.netbootBundle = pkgs.symlinkJoin {
    name = "netboot";
    paths = with config.system.build; [
      netbootRamdisk
      kernel
      netbootIpxeScript
    ];
    preferLocalBuild = true;
  };

  users.users = {
    # Drop the installer profile's empty passwords.
    root.initialHashedPassword = lib.mkForce null;
    nixos.initialHashedPassword = lib.mkForce null;
  };

  networking.useDHCP = lib.mkForce true;
  networking.useNetworkd = lib.mkForce true;
  networking.networkmanager.enable = lib.mkForce false;

  networking.hostName = "nixos-netboot";
  networking.wireless.enable = true;

  # The installer profile permits root SSH login.
  services.openssh.settings.PermitRootLogin = lib.mkForce "no";

  services.getty.autologinUser = lib.mkForce config.users.users.jawn.name;
}
