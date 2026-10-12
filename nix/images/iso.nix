{
  config,
  lib,
  modulesPath,
  ...
}:
{
  imports = [
    (modulesPath + "/installer/cd-dvd/installation-cd-minimal.nix")
    ../hardware/x86
  ];

  users.motd = ''

    === jonpulsifer/infra live installer ===
  '';

  users.users = {
    # Drop the installer profile's empty passwords.
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

  # The installer profile permits root SSH login.
  services.openssh.settings.PermitRootLogin = lib.mkForce "no";

  services.getty.autologinUser = lib.mkForce config.users.users.jawn.name;
}
