{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  sshKeys = lib.splitString "\n" (builtins.readFile inputs.keys);
in
{
  programs.zsh.enable = true;
  users.mutableUsers = false;
  users.users.root.hashedPassword = "$6$MyfHzd0UhaiNWR2.$e3CjotacfdkRzNBs/AyIGLkneJCeIZcIVd2zLm5cEoJbSCpKB2ilEAIBtqZQl6xiNgngoFH6dyqyabhwjYVQU/";

  users.users.jawn = {
    uid = lib.mkForce 1337;
    isNormalUser = true;
    extraGroups = [
      "wheel"
      "tty"
    ]
    ++ lib.optionals (config.virtualisation.docker.enable) [ "docker" ];
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
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKhYENJ/NOSUFerGNB5eIxjxeMNhmosbX62hLgZKNbUp"
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEjjytlZ6wzNpjkYNVPZm631HvbfqQu94FsoiNflUO1 rowbutt@homelab"
    ];
    shell = pkgs.zsh;
    packages = with pkgs; [
      git
      unzip
      gnupg
    ];
  };
}
