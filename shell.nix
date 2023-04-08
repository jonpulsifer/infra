{ pkgs ? import <nixpkgs> { } }:
with pkgs;
mkShell {
  buildInputs = [
    nixpkgs-fmt
    argocd
    cilium-cli
    fluxcd
    google-cloud-sdk
    grafana-loki
    kubectl
    kubernetes-helm
    sops
    terraform
    vault
  ];

  shellHook = ''
    ${pkgs.figlet}/bin/figlet -f slant "NixOps x Infra" | ${pkgs.lolcat}/bin/lolcat -a -d 2
    echo -e "Welcome to the infra repo! This is a nix-shell environment.
    It contains all the tools you need to work with this repo.\n" | ${pkgs.lolcat}/bin/lolcat -a -d 2

    echo "To get started, run 'TODO: lol' to deploy the infra." | ${pkgs.lolcat}/bin/lolcat -a -d 2
  '';
}
