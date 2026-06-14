{
  config,
  lib,
  pkgs,
  inputs,
  modulesPath,
  ...
}:
let
  disko = inputs.disko.packages.${pkgs.stdenv.hostPlatform.system}.disko;

  homelab-install = pkgs.writeShellApplication {
    name = "homelab-install";
    runtimeInputs = [
      disko
      pkgs.nixos-install-tools
      pkgs.util-linux
    ];
    text = builtins.readFile ./homelab-install.sh;
  };
in
{
  imports = [
    (modulesPath + "/installer/cd-dvd/installation-cd-minimal.nix")
    ../hardware/x86
    ../services/common.nix
  ];

  # Provisioning tooling + instructions baked into the live image.
  environment.systemPackages = [
    disko
    homelab-install
  ];

  environment.etc."README".source = ./INSTALL.md;

  users.motd = ''

    === jonpulsifer/infra live installer ===
    Install a host:   sudo homelab-install <host>
    Full guide:       less /etc/README
    Hosts:            optiplex riptide shale oldschool retrofit
  '';

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
