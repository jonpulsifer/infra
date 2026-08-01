# The single entry point for every NixOS closure in this repo.
#
# One calling convention, no modes: everything a caller can pass is listed
# below and everything listed below is honoured. The baseline is applied here
# rather than imported per-host, so a host cannot silently miss it — divergence
# is a `homelab.fleet.*` option in the host file, not a forgotten import.
{
  lib,
  nixosSystem,
  inputs,
}:
let
  baselines = {
    # Deployed hosts: the full fleet baseline.
    fleet = ../profiles/fleet.nix;
    # Images that deliberately want less (WSL, containers, the RAM-booted
    # rackpi5) compose their own narrow import list on top of the floor.
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
        # mkDefault so an image config that takes its identity from elsewhere
        # (nix/images/gce.nix reads it from GCE metadata, the installer images
        # pin their own) can still override it.
        { networking.hostName = lib.mkDefault name; }
      ]
      ++ modules;

      specialArgs = {
        inherit inputs name tags;
        # nixos-raspberrypi's board modules expect this as a top-level
        # specialArg (not inputs.nixos-raspberrypi) so they can resolve their
        # own packages/overlays.
        nixos-raspberrypi = inputs.nixos-raspberrypi;
      };
    };
}
