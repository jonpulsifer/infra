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
    # `skiff-ubuntu` promises a hosted-shaped runner -- 4 vCPU / 16 GiB -- and
    # no host here declares that shape. One label spanning two very different
    # boxes made every measurement on it a coin toss: an eight-wide benchmark
    # put eight jobs on a hosted-shaped host at 289-328 s and the ninth here at
    # 620 s, which read as a variance problem in the pool and was really a job
    # on a quarter of the machine, across a satellite link.
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
      # 6144M, not 3072M: measured on this host while the suite ran, the guest
      # faulted in its whole 3072M before the Test step even started and sat
      # there, and `bun test` died of it -- a moving segfault site, which is
      # starvation rather than a logic bug. The figure is a ceiling and not a
      # reservation: cloud-hypervisor is handed `--memory size=,shared=on` and
      # nothing else, so an idle warm slot costs what it touched at boot
      # (measured here: 484 MiB), not what it declares.
      memory = "6144M";
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

  # Class ceiling is one 6144M skiff; the bound exists so a runaway pool can
  # never make the host OOM killer choose between a skiff and kubelet.
  #
  # The headroom above the ceiling is not slack. A skiff's guest RAM is shmem
  # -- virtiofs forces `shared=on` on every one of them -- and this host has no
  # swap, so those pages cannot be reclaimed at all; what reclaim has to work
  # with is the page cache for the slot's workspace image, charged to the same
  # cgroup. At the old 4G against a 3072M class that left under a gigabyte, and
  # the whole job ran pinned at `memory.max`: 7000 reclaim events in one pass of
  # the suite, none of them optional. 8G against 6144M leaves reclaim something
  # to find. It still kills rather than throttles when a job genuinely overruns,
  # because with no swap that is the only thing a bound can do -- and a killed
  # skiff rather than a killed kubelet is the choice this bound exists to make.
  #
  # Measured 2026-08-20: 15.2 GiB total, ~3.6 GiB held by kubelet, yarr,
  # harmonia and the system, no swap and no zram.
  systemd.services.bosun.serviceConfig.MemoryMax = "8G";
}
