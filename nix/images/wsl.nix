{
  lib,
  pkgs,
  inputs,
  ...
}:
{
  imports = [
    inputs.nixos-wsl.nixosModules.default
    ../system/user.nix
    ../system/nixos.nix
    ../system/chezmoi.nix
  ];

  nixpkgs.config.allowUnfree = true;

  wsl = {
    enable = true;
    defaultUser = "jawn";
    useWindowsDriver = true;
    ssh-agent.enable = true;
    # Enable integration with Docker Desktop (needs to be installed separately)
    docker-desktop.enable = true;
    # https://github.com/nix-community/NixOS-WSL/issues/1081 Docker Desktop v4.80.0+
    extraBin = [
      { src = "${pkgs.coreutils}/bin/install"; }
      { src = "${pkgs.coreutils}/bin/mv"; }
    ];
  };

  i18n.defaultLocale = "en_US.UTF-8";

  # resolf.conf is managed by WSL (wsl.wslConf.network.generateResolvConf)
  services.resolved.enable = lib.mkForce false;

  environment.systemPackages = [
    pkgs.wget
    pkgs.python3
    # pkgs.pipx
  ];

  programs.nix-ld.enable = true;

  programs.zsh.enable = true;
  system.stateVersion = "26.05";
}
