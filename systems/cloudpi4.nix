{ config, ... }:
{
  networking.stevenBlackHosts = {
    enable = true;
    enableIPv6 = true;
    blockFakenews = true;
    blockGambling = true;
    blockPorn = true;
    blockSocial = true;
  };
}
