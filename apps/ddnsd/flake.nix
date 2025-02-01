{
  description = "ddnsd, a dynamic DNS updater for Cloudflare-managed domains";

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-unstable";
    gomod2nix = {
      url = "github:nix-community/gomod2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, gomod2nix, ... }:
    let
      ddnsd = { pkgs, ... }:
        pkgs.buildGoApplication rec {
          pname = "ddnsd";
          version = "0.0.1";
          src = ./.;
          modules = ./gomod2nix.toml;
        };
      buildDeps = with pkgs; [ git go ];
      devDeps = with pkgs; buildDeps ++ [
        go
        gopls
        gotools
        go-tools
        gomod2nix.packages.${system}.default
      ];
      pkgs = import nixpkgs {
        system = "x86_64-linux";
        overlays = [
          gomod2nix.overlays.default
          (final: prev: {
            go = prev.go_1_23;
            buildGoModule = prev.buildGo123Module;
          })
        ];
      };
    in
    {
      packages.x86_64-linux.default = ddnsd { inherit pkgs; };
      formatter.x86_64-linux = pkgs.nixpkgs-fmt;
      devShells.x86_64-linux.default = pkgs.mkShell { buildInputs = devDeps; };
      nixosModules.default = ./module.nix;
      overlays.pkgs = final: prev: {
        ddnsd = prev.callPackage ddnsd { inherit pkgs; };
      };
    };
}
