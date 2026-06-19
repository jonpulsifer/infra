{
  config,
  pkgs,
  lib,
  ...
}:
let
  user = config.users.users.jawn;
  # Dotfiles now live in this monorepo under dotfiles/; the repo-root
  # .chezmoiroot points chezmoi at that subdirectory.
  dotfilesRepo = "github:jonpulsifer/infra";
in
lib.mkIf (user.isNormalUser or false) {
  environment.systemPackages = [ pkgs.chezmoi ];

  system.activationScripts.chezmoi = {
    deps = [
      "users"
      "groups"
    ];
    text = ''
      source_dir="${user.home}/.local/share/chezmoi"
      chezmoi="${pkgs.chezmoi}/bin/chezmoi"
      if [ ! -d "$source_dir/.git" ]; then
        HOME="${user.home}" \
        ${pkgs.sudo}/bin/sudo --preserve-env=HOME -u ${user.name} \
          $chezmoi init ${dotfilesRepo} 2>/dev/null || true
      fi
      if [ -d "$source_dir" ]; then
        HOME="${user.home}" \
        ${pkgs.sudo}/bin/sudo --preserve-env=HOME -u ${user.name} \
          $chezmoi apply --no-tty --force 2>/dev/null || true
      fi
    '';
  };
}
