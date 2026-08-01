# The floor every NixOS closure in this repo shares — hosts and images alike.
#
# Holds the compatibility baseline plus the option surface that ../profiles/fleet.nix
# implements. Options are declared here rather than in fleet.nix so that image
# configurations, which take the floor but not the full host baseline, can still
# reference them (nix/images/wsl.nix imports mise-dotfiles without the baseline).
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
