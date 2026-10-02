{
  config,
  pkgs,
  lib,
  inputs,
  ...
}:
let
  user = config.users.users.jawn;
  # Only dotfiles/ enters the closure, so mise applies from a store path with no network clone.
  dotfilesSource = builtins.path {
    path = "${inputs.self}/dotfiles";
    name = "mise-dotfiles";
  };
  mise = pkgs.callPackage ../lib/mise.nix { };
  # Activation's PATH has no shell and no mise, and the task runs under sh and calls mise.
  path = lib.makeBinPath [
    mise
    pkgs.bash
    pkgs.coreutils
    pkgs.findutils
    pkgs.gnugrep
    pkgs.gnused
  ];
  # The template detects WSL by a non-empty WSL_DISTRO_NAME, which activation does not inherit, so
  # the WSL image sets a placeholder. wsl.enable exists only when nixos-wsl is imported. The env
  # comes after sudo so that sudo's environment policy cannot drop it. Offline, quiet and with
  # auto-install off, `mise run` neither resolves nor installs the global config's tools, which
  # would stall activation on the network, and prints only errors and what the deploy moved.
  asUser = lib.concatStringsSep " " (
    [
      "${pkgs.sudo}/bin/sudo -u ${user.name} -- ${pkgs.coreutils}/bin/env"
      "HOME=${user.home}"
      "PATH=${path}"
      "MISE_YES=1"
      "MISE_OFFLINE=1"
      "MISE_QUIET=1"
      "MISE_TASK_RUN_AUTO_INSTALL=0"
    ]
    # mise.hm.toml leaves zsh and nvim to home-manager.
    ++ lib.optional config.homelab.fleet.homeManager "MISE_ENV=hm"
    ++ lib.optional (config.wsl.enable or false) "WSL_DISTRO_NAME=\"\${WSL_DISTRO_NAME:-NixOS}\""
  );
in
lib.mkIf (config.homelab.fleet.miseDotfiles && (user.isNormalUser or false)) {
  system.activationScripts.miseDotfiles = {
    deps = [
      "users"
      "groups"
    ];
    # A dotfiles failure must not fail activation and strand the host, so neither command can fail
    # the snippet. A failed deploy leaves its errors and a closing line in the switch output and the
    # journal. `--cd` goes before `run`: after the task name it is an argument to the task.
    text = ''
      ${asUser} ${mise}/bin/mise trust -y ${dotfilesSource} || true
      ${asUser} ${mise}/bin/mise --cd ${dotfilesSource} run dotfiles:deploy \
        || echo "miseDotfiles: dotfiles:deploy failed with exit $?; the errors above say why" >&2
    '';
  };
}
