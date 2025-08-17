{
  config,
  pkgs,
  lib,
  ...
}:
{
  home.shellAliases = {
    "," = "nr";
  };

  programs.zsh.initContent = ''
    # Run a package from this flake's pinned nixpkgs without updating channels
    # Usage: nr <pkg> [-- args]
    nr() {
      local pkg="$1"; shift || true
      if [[ -z "$pkg" ]]; then
        echo "usage: nr <pkg> [-- args]" >&2
        return 1
      fi
      nix run path:$HOME/src/github.com/jonpulsifer/dotfiles#''${pkg} -- "$@"
    }

    ns() {
      local pkg="$1"; shift || true
      if [[ -z "$pkg" ]]; then
        echo "usage: ns <pkg> [-- args]" >&2
        return 1
      fi
      nix shell path:$HOME/src/github.com/jonpulsifer/dotfiles#''${pkg} -- "$@"
    }
  '';

  nix = {
    package = lib.mkDefault pkgs.nix;
    settings = {
      substituters = [
        "https://jonpulsifer.cachix.org"
        "https://cache.nixos.org"
        "https://nix-community.cachix.org"
      ];
      trusted-public-keys = [
        "jonpulsifer.cachix.org-1:Rwya0JXhlZXczd5v3JVBgY0pU5tUbiaqw5RfFdxBakQ="
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
    };
  };
}
