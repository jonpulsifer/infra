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
  mise = pkgs.mise;
  # The templates detect WSL by a non-empty WSL_DISTRO_NAME, which activation does not inherit, so the
  # WSL image sets a placeholder. wsl.enable exists only when nixos-wsl is imported.
  isWsl = config.wsl.enable or false;
  wslEnv = lib.optionalString isWsl ''WSL_DISTRO_NAME="''${WSL_DISTRO_NAME:-NixOS}" '';
  preserveEnv = "HOME,MISE_YES" + lib.optionalString isWsl ",WSL_DISTRO_NAME";
in
lib.mkIf (config.homelab.fleet.miseDotfiles && (user.isNormalUser or false)) {
  system.activationScripts.miseDotfiles = {
    deps = [
      "users"
      "groups"
    ];
    # A dotfiles failure must not fail activation and strand the host. Keep stderr so a failing
    # bootstrap leaves a trace.
    text = ''
      HOME="${user.home}" MISE_YES=1 ${wslEnv}\
      ${pkgs.sudo}/bin/sudo --preserve-env=${preserveEnv} -u ${user.name} \
        ${mise}/bin/mise trust -y ${dotfilesSource} || true
      HOME="${user.home}" MISE_YES=1 ${wslEnv}HM_ACTIVATED=1 \
      ${pkgs.sudo}/bin/sudo --preserve-env=${preserveEnv},HM_ACTIVATED -u ${user.name} \
        ${mise}/bin/mise run bootstrap -y --cd ${dotfilesSource} || true
    '';
  };
}
