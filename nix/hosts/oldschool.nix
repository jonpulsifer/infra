# oldschool: offsite worker node that also carries the site's odd jobs —
# yarr, the offsite harmonia binary cache, and a one-slot bosun pool.
{ config, inputs, ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../services/yarr.nix
    ../system/quiker.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
    ../../apps/bosun/module.nix
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

  # Shared with riptide: both are bosun hosts on the same Spindrift+bosun
  # GitHub App, each holding this same key.
  sops.secrets."bosun-github-app-key" = {
    sopsFile = ../secrets/bosun.sops.yaml;
    owner = "bosun";
    group = "bosun";
    mode = "0400";
    restartUnits = [ "bosun.service" ];
  };

  # One warm FHS slot at the site with the fast internet. The class shape
  # is the standard skiff-ubuntu shape so the label stays homogeneous; the
  # neighbourhood -- kubelet, yarr and harmonia share the same 4 cores and
  # 16 GiB, and that contention is part of any number measured on this slot.
  services.bosun = {
    enable = true;
    repo = "jonpulsifer/infra";
    github = {
      # The shared Spindrift+bosun GitHub App ("spindrift-bot").
      appId = 4576122;
      privateKeyFile = config.sops.secrets."bosun-github-app-key".path;
    };
    # `skiff-offsite`, not `skiff-ubuntu`, because this is not that machine.
    # `skiff-ubuntu` means a hosted-shaped runner -- 4 vCPU / 16 GiB, what
    # tender serves -- and one label spanning two very different boxes made
    # every measurement on it a coin toss: an eight-wide benchmark put eight
    # jobs on tender at 289-328 s and the ninth here at 620 s, which read as a
    # variance problem in the pool and was really a job on a quarter of the
    # machine, across a satellite link.
    #
    # The capacity is still worth having, and a workflow that wants it can name
    # it. What it must not do is arrive by accident at a label that promises
    # something else.
    classes.skiff-offsite = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      # 2, not 4: this box has 4 cores shared with kubelet, yarr and
      # harmonia, and a skiff that can contend for all of them is how the
      # suite's DB-timing tests flake -- the same signature the ARC runner
      # here showed twice in the bench. Half the cores caps the contention;
      # the bench put the Build delta at seconds, not minutes.
      vcpus = 2;
      memory = "3072M";
      workspace = "6G";
      persist = true;
      warm = 1;
    };

    # No xl class here on purpose: image builds want cores and disk this box
    # is already spending on kubelet, yarr and harmonia. The suite slot and
    # the cache service are what the fast-internet site contributes.

    # 30 GB of the 200 GB root for the actions/cache service — this is the
    # site with the fast internet, so a cold miss refills it cheapest here.
    cache = {
      enable = true;
      maxSizeBytes = 32212254720;
    };
  };

  # Class ceiling is one 3072M skiff; the bound exists so a runaway pool can
  # never make the host OOM killer choose between a skiff and kubelet.
  systemd.services.bosun.serviceConfig.MemoryMax = "4G";
}
