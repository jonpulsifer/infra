{
  lib,
  pkgs,
  inputs,
  ...
}:
{
  imports = [
    inputs.nixos-wsl.nixosModules.default
    ../system/home-manager.nix
    ../system/user.nix
    ../system/nixos.nix
    ../system/mise-dotfiles.nix
  ];

  nixpkgs.config.allowUnfree = true;

  # A generic image identity; plain priority beats mkHost's registry name.
  networking.hostName = "nixos";

  # Lets this x86_64 host build the Pi sdImage outputs.
  boot.binfmt.emulatedSystems = [ "aarch64-linux" ];
  # WSL sometimes mounts binfmt_misc read-only; skip the unit then so a switch
  # still succeeds.
  systemd.services.systemd-binfmt.unitConfig.ConditionPathIsReadWrite = "/proc/sys/fs/binfmt_misc";
  # NixOS's binfmt module replaces the binfmt_misc table on activation, which
  # drops WSL's .exe interop handler unless this registers it again.
  wsl.interop.register = true;

  wsl = {
    enable = true;
    defaultUser = "jawn";
    useWindowsDriver = true;
    ssh-agent.enable = true;
  };

  i18n.defaultLocale = "en_US.UTF-8";

  # WSL writes resolv.conf (wsl.wslConf.network.generateResolvConf).
  services.resolved.enable = lib.mkForce false;

  environment.systemPackages = [
    pkgs.wget
    pkgs.python3
    pkgs.bubblewrap
  ];

  programs.zsh.enable = true;
}
