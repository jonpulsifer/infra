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

  # The motd's host list: every Kubernetes node, by its cluster tag.
  installableHosts = lib.attrNames (
    lib.filterAttrs (
      _: entry:
      lib.any (
        tag:
        lib.elem tag [
          "folly"
          "offsite"
        ]
      ) (entry.tags or [ ])
    ) (import ../hosts)
  );

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
  ];

  environment.systemPackages = [
    disko
    homelab-install
  ];

  environment.etc."README".source = ./INSTALL.md;

  users.motd = ''

    === jonpulsifer/infra live installer ===
    Install a host:   sudo homelab-install <host>
    Full guide:       less /etc/README
    Hosts:            ${lib.concatStringsSep " " installableHosts}
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
