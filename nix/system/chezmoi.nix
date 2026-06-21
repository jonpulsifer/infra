{
  config,
  pkgs,
  lib,
  inputs,
  ...
}:
let
  user = config.users.users.jawn;
  # Dotfiles live in this monorepo under dotfiles/ (the repo-root .chezmoiroot
  # points chezmoi at that subdirectory). Carry just that subtree into the
  # system closure via the flake source so chezmoi applies from a local store
  # path — no network clone, no build-time seeding, and it self-heals on every
  # activation.
  chezmoiSource = builtins.path {
    path = "${inputs.self}/dotfiles";
    name = "chezmoi-dotfiles";
  };
in
lib.mkIf (user.isNormalUser or false) {
  environment.systemPackages = [ pkgs.chezmoi ];

  system.activationScripts.chezmoi = {
    deps = [
      "users"
      "groups"
    ];
    text = ''
      HOME="${user.home}" \
      ${pkgs.sudo}/bin/sudo --preserve-env=HOME -u ${user.name} \
        ${pkgs.chezmoi}/bin/chezmoi apply \
          --source ${chezmoiSource} \
          --no-tty --force 2>/dev/null || true
    '';
  };
}
