{
  description = "ddnsd, a dynamic DNS updater for Cloudflare-managed domains";

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-25.05";
  };

  outputs = { self, nixpkgs, ... }:
    let
      ddnsd = { pkgs, ... }:
        pkgs.buildGoModule rec {
          pname = "ddnsd";
          version = "0.0.1";
          src = ./.;
          vendorHash = "sha256-4AP7m6gj30mCQ2naNlleH7JjS4R0J2c7Yvd/2/yYdYM=";
          subPackages = [ "." ];
        };
      buildDeps = with pkgs; [ git go ];
      devDeps = with pkgs; buildDeps ++ [
        go
        gopls
        gotools
        go-tools
      ];
      pkgs = import nixpkgs {
        system = "x86_64-linux";
        overlays = [
          # (final: prev: {
          #   go = prev.go_1_23;
          #   buildGoModule = prev.buildGo123Module;
          # })
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
