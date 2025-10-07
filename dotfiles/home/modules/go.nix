{ config, pkgs, ... }:
{
  home.sessionPath = [ "${config.home.homeDirectory}/bin" ];
  home.sessionVariables = {
    GOPATH = config.home.homeDirectory;
  };
  home.packages = with pkgs; [
    go
    gopls
    gotools
    go-tools
  ];
}
