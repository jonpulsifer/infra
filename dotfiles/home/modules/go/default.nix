{ config, pkgs, ... }:
let inherit (config.home) homeDirectory;
in {
  home.sessionPath = [ "${homeDirectory}/bin" ];
  home.sessionVariables = { GOPATH = homeDirectory; };
  home.packages = with pkgs; [
    go_1_22
    gopls
    gotools
    go-tools
  ];
}
