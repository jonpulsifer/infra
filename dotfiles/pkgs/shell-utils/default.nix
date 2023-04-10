{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "shell-utils";
  version = "0.1.0";
  src = ./bin;
  buildinputs = [ pkgs.bash ];
  installPhase = ''
    mkdir -p $out/bin
    cp $src/* $out/bin
  '';
}
