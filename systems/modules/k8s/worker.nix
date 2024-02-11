{ config, lib, pkgs, ... }:
{
  imports = [ ./common.nix ];
  services.kubernetes = {
    kubelet.enable = true;
  };
}
