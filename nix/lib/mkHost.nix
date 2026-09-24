# The single entry point for every NixOS closure. It applies the baseline, so a host cannot
# miss it; a host diverges through `homelab.fleet.*` options.
{
  lib,
  nixosSystem,
  inputs,
}:
let
  baselines = {
    fleet = ../profiles/fleet.nix;
    base = ../profiles/base.nix;
  };
in
{
  mkHost =
    name:
    {
      system ? "x86_64-linux",
      tags ? [ ],
      baseline ? "fleet",
      modules,
    }:
    nixosSystem {
      inherit system;

      modules = [
        baselines.${baseline}
        # Beats mkDefault (1000), such as google-compute-config's empty hostname, so nixos-upgrade
        # finds this configuration. Loses to a normal (100) value, so wsl and installer images keep theirs.
        { networking.hostName = lib.mkOverride 900 name; }
      ]
      ++ modules;

      specialArgs = {
        inherit inputs name tags;
        # nixos-raspberrypi's board modules read their own flake from this top-level specialArg.
        nixos-raspberrypi = inputs.nixos-raspberrypi;
      };
    };
}
