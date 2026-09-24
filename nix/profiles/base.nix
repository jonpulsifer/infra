# The floor every NixOS closure shares, hosts and images alike. It declares the homelab.fleet
# options so images without ./fleet.nix can still set them (nix/images/wsl.nix imports mise-dotfiles).
{ lib, ... }:
{
  options.homelab.fleet = {
    miseDotfiles = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Apply the in-repo dotfiles with mise on activation. Turn off where no
        mise binary exists for the platform (armv6l).
      '';
    };

    homeManager = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Wire home-manager for the jawn user so programs.<x> drive shell
        tooling (bat, btop, fzf, neovim, gh, git-delta, eza, zsh plugins).
        Turn off where the platform can't build them (armv6l).
      '';
    };

    metrics = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Run the Prometheus node exporter. Turn off on hosts too small or too
        slow to build it.
      '';
    };

    terminfo = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Install the full terminfo database. Turn off where the extra closure
        has to be cross-compiled for a platform with no binary cache.
      '';
    };
  };

  # Compatibility baseline for systems first declared on NixOS 26.05.
  # Routine upgrades must not bump this value.
  config.system.stateVersion = lib.mkDefault "26.05";
}
