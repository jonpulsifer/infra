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

  # The generic image identity. Not the flake attribute name: the real distro
  # name is chosen at `wsl --import` time and this is only what the tarball
  # boots with until then.
  networking.hostName = "nixos";

  # Emulate aarch64 via qemu-user/binfmt so we can build the Pi (pi4/pi5)
  # sdImage outputs on this x86_64 host instead of needing a native aarch64
  # builder or a remote builder.
  boot.binfmt.emulatedSystems = [ "aarch64-linux" ];
  # WSL sometimes exposes binfmt_misc read-only. Skip the upstream unit in
  # that case so a system switch succeeds; it starts normally when WSL makes
  # the filesystem writable again.
  systemd.services.systemd-binfmt.unitConfig.ConditionPathIsReadWrite = "/proc/sys/fs/binfmt_misc";
  # NixOS's binfmt module takes over the whole binfmt_misc table on
  # activation; without this, adding the aarch64 registration above wipes
  # out WSL2's own .exe interop handler and breaks running Windows binaries
  # (explorer.exe, code.exe, wslc.exe, ...) from inside WSL.
  wsl.interop.register = true;

  wsl = {
    enable = true;
    defaultUser = "jawn";
    useWindowsDriver = true;
    ssh-agent.enable = true;
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

  programs.zsh.enable = true;
}
