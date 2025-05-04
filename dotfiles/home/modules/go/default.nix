{ config, pkgs, ... }:
{
  home.sessionPath = [ "${config.home.homeDirectory}/bin" ];
  home.sessionVariables = {
    GOPATH = config.home.homeDirectory;
  };
  home.packages = with pkgs; [
    go_1_24
    gopls
    gotools
    go-tools
  ];
}
