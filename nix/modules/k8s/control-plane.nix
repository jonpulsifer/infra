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
        config.networking.hostName
        "${config.networking.hostName}.lolwtf.ca"
        "${config.networking.hostName}.fml.pulsifer.ca"
        "${config.networking.hostName}.pirate-musical.ts.net"
        config.services.kubernetes.apiserver.advertiseAddress
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
