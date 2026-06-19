{
  description = "ddnsd, a dynamic DNS updater for Cloudflare-managed domains";

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-25.05";
  };

  outputs = { self, nixpkgs, ... }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };

      ddnsd = { pkgs, ... }:
        pkgs.buildGoModule rec {
          pname = "ddnsd";
          version = "0.0.1";
          src = ./.;
          vendorHash = "sha256-4AP7m6gj30mCQ2naNlleH7JjS4R0J2c7Yvd/2/yYdYM=";
          subPackages = [ "." ];

          meta = with pkgs.lib; {
            description = "A dynamic DNS updater for Cloudflare-managed domains";
            homepage = "https://github.com/jonpulsifer/ddnsd";
            license = licenses.mit;
            maintainers = [ ];
            platforms = platforms.linux;
          };
        };

      mkBuildDeps = pkgs: with pkgs; [ git go ];
      mkDevDeps = pkgs: with pkgs; (mkBuildDeps pkgs) ++ [
        go
        gopls
        gotools
        go-tools
      ];
    in
    {
      packages = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = ddnsd { inherit pkgs; };
        });

      formatter = forAllSystems (system:
        let pkgs = pkgsFor system;
        in pkgs.nixpkgs-fmt);

      devShells = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = pkgs.mkShell { buildInputs = mkDevDeps pkgs; };
        });

      nixosModules.default = ./module.nix;
      overlays.pkgs = final: prev: {
        ddnsd = prev.callPackage ddnsd { };
      };
    };
}
