{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "shell-utils";
  version = "0.1.1";
  src = ./shell-utils;
  buildinputs = [ pkgs.bash ];
  installPhase = ''
    mkdir -p $out/bin
    install -m 755 $src/* $out/bin
  '';
}
