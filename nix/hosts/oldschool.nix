# oldschool: offsite worker node that also carries the site's odd jobs —
# yarr and the offsite harmonia binary cache.
{ ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../services/yarr.nix
    ../system/quiker.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
  ];

  services.k8s.clusterCa.enable = true;

  homelab.disko.device = "/dev/sda";
  # 200G root (default is 100G) — leaves headroom for the harmonia
  # binary cache + remote-builder role on top of yarr.
  homelab.disko.rootSize = "200G";

  sops.defaultSopsFile = ../secrets/oldschool.sops.yaml;
  # harmonia's binary-cache signing key (public half committed at
  # nix/secrets/oldschool-harmonia-cache.pub); wired into
  # services.harmonia in the deploy-harmonia ticket.
  sops.secrets."harmonia-cache-key" = { };
}
