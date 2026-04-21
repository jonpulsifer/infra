{
  pkgs ? import <nixpkgs> { },
}:
with pkgs;
let
  packages = [
    argocd
    cilium-cli
    fluxcd
    git
    google-cloud-sdk
    kubectl
    kubernetes-helm
    mise
    nix
    nixos-rebuild
    python3
    sops
    terraform
  ];
in
mkShell {
  buildInputs = packages;

  shellHook = ''
    ${pkgs.figlet}/bin/figlet -f isometric3 "Infra" | ${dotacat}/bin/dotacat
    echo -e "Welcome to the infra repo! This is a nix-shell environment.
    It contains all the tools you need to work with my infra." | ${dotacat}/bin/dotacat
    echo "Available packages:" | ${dotacat}/bin/dotacat
    printf '${
      lib.concatMapStringsSep "\\n" (pkg: "  • ${pkg.pname or pkg.name}") packages
    }\n' | ${dotacat}/bin/dotacat
  '';
}
