{
  config,
  pkgs,
  lib,
  ...
}:
let
  buildShellScriptBin =
    name: file:
    pkgs.stdenvNoCC.mkDerivation {
      pname = name;
      version = "0.1";
      src = file;
      installPhase = ''
        mkdir -p $out/bin
        install -m 755 $src $out/bin/${name}
      '';
      dontUnpack = true;
    };

in
{
  home.shellAliases = {
    "," = "nr";
  };

  home.packages = with pkgs; [
    (buildShellScriptBin "np" ./shell-utils/np)
    (buildShellScriptBin "nr" ./shell-utils/nr)
    (buildShellScriptBin "ns" ./shell-utils/ns)
  ];

  nix = {
    package = lib.mkDefault pkgs.nix;
    settings = {
      substituters = [
        "https://jonpulsifer.cachix.org"
        "https://cache.nixos.org"
        "https://nix-community.cachix.org"
      ];
      trusted-public-keys = [
        "jonpulsifer.cachix.org-1:Rwya0JXhlZXczd5v3JVBgY0pU5tUbiaqw5RfFdxBakQ="
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
    };
  };
}
