{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  sshKeys = lib.splitString "\n" (builtins.readFile inputs.keys);
  rowbuttKeys = lib.splitString "\n" (builtins.readFile inputs.rowbuttkeys);
  consolePasswordHash = "$6$MyfHzd0UhaiNWR2.$e3CjotacfdkRzNBs/AyIGLkneJCeIZcIVd2zLm5cEoJbSCpKB2ilEAIBtqZQl6xiNgngoFH6dyqyabhwjYVQU/";
in
{
  programs.zsh.enable = true;

  # Nix installs only the mise binary; mise manages runtimes and shims under ~/.local/share/mise.
  # It is the release pinned in ../lib/mise.nix, which has no armv6l build, so the pi-zero profile
  # turns this off.
  environment.systemPackages = lib.optional config.homelab.fleet.miseDotfiles (
    pkgs.callPackage ../lib/mise.nix { }
  );

  users.mutableUsers = false;
  users.users.root.hashedPassword = consolePasswordHash;

  users.users.jawn = {
    uid = lib.mkForce 1337;
    isNormalUser = true;
    extraGroups = [
      "wheel"
      "tty"
    ]
    ++ lib.optionals (config.virtualisation.docker.enable) [ "docker" ];
    hashedPassword = consolePasswordHash;
    openssh.authorizedKeys.keys = sshKeys;
    shell = pkgs.zsh;
    packages = with pkgs; [
      git
      unzip
      gnupg
    ];
  };

  users.users.rowbutt = {
    uid = 1339;
    isNormalUser = true;
    extraGroups = [
      "wheel"
      "tty"
    ]
    ++ lib.optionals (config.virtualisation.docker.enable) [ "docker" ];
    openssh.authorizedKeys.keys = rowbuttKeys;
    shell = pkgs.zsh;
    packages = with pkgs; [
      git
      unzip
      gnupg
    ];
  };
}
