{
  config,
  lib,
  pkgs,
  ...
}:

{
  imports = [ ./common.nix ];
  services.etcd.enable = true;
  services.kubernetes = {
    apiserver = {
      enable = true;
      allowPrivileged = true;
      extraSANs = [
        "nuc"
        "nuc.lolwtf.ca"
        "nuc.fml.pulsifer.ca"
        "nuc.pirate-musical.ts.net"
        "10.3.0.10"
      ];
      extraOpts = ''
        --enable-aggregator-routing=true \
        --requestheader-allowed-names=front-proxy-client \
        --requestheader-extra-headers-prefix=X-Remote-Extra- \
        --requestheader-group-headers=X-Remote-Group \
        --requestheader-username-headers=X-Remote-User
      '';
    };
    controllerManager.enable = true;
    scheduler.enable = true;
    addonManager.enable = true;
    proxy.enable = false;
  };
}
