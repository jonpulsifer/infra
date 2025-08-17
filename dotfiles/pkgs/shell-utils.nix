{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "shell-utils";
  version = "0.1.0";
  src = ./shell-utils;
  buildinputs = [ pkgs.bash ];
  installPhase = ''
    mkdir -p $out/bin
    cp $src/* $out/bin
  '';
}
