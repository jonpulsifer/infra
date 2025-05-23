{
  lib,
  pkgs,
  config,
  modulesPath,
  ...
}:
{
  wsl = {
    enable = true;
    defaultUser = "jawn";
    # Enable integration with Docker Desktop (needs to be installed separately)
    # docker.enable = true;
  };

  system.build.installBootLoader = lib.mkForce "${pkgs.coreutils}/bin/true";

  i18n.defaultLocale = "en_US.UTF-8";

  # resolf.conf is managed by WSL (wsl.wslConf.network.generateResolvConf)
  services.resolved.enable = lib.mkForce false;

  # https://nix-community.github.io/NixOS-WSL/how-to/vscode.html
  environment.systemPackages = [
    pkgs.wget
  ];

  programs.nix-ld = {
    enable = true;
    package = pkgs.nix-ld-rs;
  };

  programs.zsh.enable = true;
  system.stateVersion = lib.mkDefault "24.11";
}
