# optiplex: folly control-plane node, rooted on a SATA disk.
#
# Runs the repo-managed FML cluster CA, so it carries both the service-account
# signing key and the cluster CA private key from sops.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s = {
    role = "control-plane";
    clusterCa.enable = true;
  };

  homelab.disko.device = "/dev/sda";

  sops.defaultSopsFile = ../secrets/optiplex.sops.yaml;
  sops.secrets."k8s-sa-signing-key" = {
    owner = "kubernetes";
    group = "kubernetes";
    mode = "0400";
    restartUnits = [
      "kube-apiserver.service"
      "kube-controller-manager.service"
    ];
  };
  sops.secrets."k8s-cluster-ca-key" = {
    owner = "cfssl";
    group = "cfssl";
    mode = "0400";
    path = "/var/lib/cfssl/ca-key.pem";
    restartUnits = [ "cfssl.service" ];
  };
}
