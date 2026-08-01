# retrofit: offsite control-plane node.
#
# The offsite cluster does not run the repo-managed FML cluster CA yet
# (services.k8s.clusterCa stays off, so kubernetes' easyCerts path issues its
# own), but the API server still signs service-account tokens with the FML
# issuer key from sops.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s.role = "control-plane";

  homelab.disko.device = "/dev/sda";

  sops.defaultSopsFile = ../secrets/retrofit.sops.yaml;
  sops.secrets."k8s-sa-signing-key" = {
    owner = "kubernetes";
    group = "kubernetes";
    mode = "0400";
    restartUnits = [
      "kube-apiserver.service"
      "kube-controller-manager.service"
    ];
  };
}
