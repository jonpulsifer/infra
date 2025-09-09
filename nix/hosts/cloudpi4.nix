{ config, lib, inputs, ... }:
{
  imports = [
    ../profiles/rpi.nix
    inputs.hosts.nixosModule
  ];

  services.ddnsd.enable = lib.mkForce false;

  networking.stevenBlackHosts = {
    enable = true;
    enableIPv6 = true;
    blockFakenews = true;
    blockGambling = true;
    blockPorn = true;
    blockSocial = true;
  };
}
