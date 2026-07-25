{ lib, ... }:
{
  # Compatibility baseline for systems first declared on NixOS 26.05.
  # Routine upgrades must not bump this value.
  system.stateVersion = lib.mkDefault "26.05";
}
