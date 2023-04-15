{ config, pkgs, ... }:
let inherit (config.home) homeDirectory;
in {
  home.sessionPath = [ "${homeDirectory}/bin" ];
  home.sessionVariables = { GOPATH = homeDirectory; };
  home.packages = with pkgs; [ go gopls ];
}
