{
  config,
  pkgs,
  lib,
  inputs,
  ...
}:
let
  user = config.users.users.jawn;
  # Dotfiles live in this monorepo under dotfiles/. Carry just that subtree into the
  # system closure via the flake source so mise applies from a local store path — no
  # network clone, no build-time seeding, and it self-heals on every activation.
  dotfilesSource = builtins.path {
    path = "${inputs.self}/dotfiles";
    name = "mise-dotfiles";
  };
  mise = inputs.mise.packages.${pkgs.stdenv.hostPlatform.system}.mise.overrideAttrs (_: {
    doCheck = false;
  });
in
lib.mkIf (user.isNormalUser or false) {
  system.activationScripts.miseDotfiles = {
    deps = [
      "users"
      "groups"
    ];
    text = ''
      HOME="${user.home}" MISE_YES=1 \
      ${pkgs.sudo}/bin/sudo --preserve-env=HOME,MISE_YES -u ${user.name} \
        ${mise}/bin/mise trust -y ${dotfilesSource} 2>/dev/null || true
      HOME="${user.home}" MISE_YES=1 \
      ${pkgs.sudo}/bin/sudo --preserve-env=HOME,MISE_YES -u ${user.name} \
        ${mise}/bin/mise bootstrap --only dotfiles -y --cd ${dotfilesSource} 2>/dev/null || true
    '';
  };
}
