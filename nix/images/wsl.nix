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
    ../system/mise-dotfiles.nix
  ];

  nixpkgs.config.allowUnfree = true;

  # Emulate aarch64 via qemu-user/binfmt so we can build the Pi (pi4/pi5)
  # sdImage outputs on this x86_64 host instead of needing a native aarch64
  # builder or a remote builder.
  boot.binfmt.emulatedSystems = [ "aarch64-linux" ];
  # NixOS's binfmt module takes over the whole binfmt_misc table on
  # activation; without this, adding the aarch64 registration above wipes
  # out WSL2's own .exe interop handler and breaks running Windows binaries
  # (explorer.exe, code.exe, Docker Desktop, ...) from inside WSL.
  wsl.interop.register = true;

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
    pkgs.bubblewrap
    # pkgs.pipx
  ];

  programs.nix-ld.enable = true;

  programs.zsh.enable = true;
  system.stateVersion = "26.05";
}
