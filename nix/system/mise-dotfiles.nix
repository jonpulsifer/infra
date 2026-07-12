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
  # Prebuilt binary via the overlay nix/system/user.nix applies system-wide (both modules
  # are imported together on every host that has either) — not the from-source jdx/mise
  # flake input.
  mise = pkgs.mise;
  # The dotfiles templates key WSL detection off WSL_DISTRO_NAME. WSL sets it for every
  # session it launches, but activation runs outside one, so on the WSL image
  # (wsl.enable, only defined when nixos-wsl is imported) supply it ourselves. The
  # templates only test non-emptiness; the real distro name is chosen at `wsl --import`
  # time and unknowable here, hence the placeholder fallback.
  isWsl = config.wsl.enable or false;
  wslEnv = lib.optionalString isWsl ''WSL_DISTRO_NAME="''${WSL_DISTRO_NAME:-NixOS}" '';
  preserveEnv = "HOME,MISE_YES" + lib.optionalString isWsl ",WSL_DISTRO_NAME";
in
lib.mkIf (user.isNormalUser or false) {
  system.activationScripts.miseDotfiles = {
    deps = [
      "users"
      "groups"
    ];
    text = ''
      HOME="${user.home}" MISE_YES=1 ${wslEnv}\
      ${pkgs.sudo}/bin/sudo --preserve-env=${preserveEnv} -u ${user.name} \
        ${mise}/bin/mise trust -y ${dotfilesSource} 2>/dev/null || true
      HOME="${user.home}" MISE_YES=1 ${wslEnv}\
      ${pkgs.sudo}/bin/sudo --preserve-env=${preserveEnv} -u ${user.name} \
        ${mise}/bin/mise bootstrap --only dotfiles -y --cd ${dotfilesSource} 2>/dev/null || true
    '';
  };
}
