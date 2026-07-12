{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  # Use the prebuilt upstream mise binary instead of building the jdx/mise
  # flake input from source on every host. See nix/overlays/mise.nix.
  miseOverlay = import ../overlays/mise.nix;

  sshKeys = lib.splitString "\n" (builtins.readFile inputs.keys);
  rowbuttKeys = lib.splitString "\n" (builtins.readFile inputs.rowbuttkeys);
  consolePasswordHash = "$6$MyfHzd0UhaiNWR2.$e3CjotacfdkRzNBs/AyIGLkneJCeIZcIVd2zLm5cEoJbSCpKB2ilEAIBtqZQl6xiNgngoFH6dyqyabhwjYVQU/";
in
{
  programs.zsh.enable = true;

  # Applied at the host level so every host's pkgs.mise resolves to the
  # prebuilt binary. (radiopi0/blinkypi0 don't pull mise into their user
  # package sets at all, so the overlay is inert there.)
  nixpkgs.overlays = [ miseOverlay ];

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
      mise
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
      mise
    ];
  };
}
