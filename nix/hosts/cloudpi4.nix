{ config, lib, inputs, ... }:
{
  imports = [
    ../profiles/rpi.nix
    inputs.hosts.nixosModule
  ];

  networking.stevenBlackHosts = {
    enable = true;
    enableIPv6 = true;
    blockFakenews = true;
    blockGambling = true;
    blockPorn = true;
    blockSocial = true;
  };
}
