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

  # Nix installs the binary and nothing else: no activation hook, no
  # home-manager `programs.mise`. Everything past that -- runtimes, k8s
  # tooling, the shims that put them on PATH -- mise manages itself out of
  # ~/.local/share/mise, which is the point of having it.
  #
  # nixpkgs' own package rather than a pinned upstream tarball, so it
  # substitutes from cache.nixos.org and no host builds it. It also carries no
  # hash to go stale: the overlay this replaces had to be refreshed by hand on
  # every bump, and a bump that skipped it broke every Nix build in the repo.
  #
  # Gated on the same flag the dotfiles bootstrap uses, which the pi-zero
  # profile already sets false. armv6l has no cache and no upstream asset, so
  # an unconditional entry here would put a from-source Rust build on the two
  # hosts least able to do one -- the case the deleted overlay handled with a
  # `throw` that only worked because nothing referenced pkgs.mise there.
  environment.systemPackages = lib.optional config.homelab.fleet.miseDotfiles pkgs.mise;

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
