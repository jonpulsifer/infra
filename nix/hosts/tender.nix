# tender: a Google Compute Engine bosun host. A tender is the boat that
# services the ship; this one keeps the warm pool that riptide keeps today,
# without spending a folly worker's RAM to do it.
#
# c4-standard-48 -- 48 vCPU / 180 GB of Granite Rapids, the fastest silicon
# GCE will nest a VM inside, and the family every recorded benchmark ran on.
# Sized to the C4 quota ceiling in us-east1 (50 vCPU), which is what makes the
# pool ten jobs wide instead of three.
#
# The image module supplies the disk layout; the hostname is the registry
# name, baked into the closure, which is what nixos-upgrade resolves.
# Terraform is in terraform/gcp/projects/homelab-ng/bosun.tf.
{ config, inputs, ... }:
{
  imports = [
    ../images/gce.nix
    ../system/sops.nix
    ../../apps/bosun/module.nix
  ];

  sops.defaultSopsFile = ../secrets/tender.sops.yaml;
  # bosun reads this once at startup, so a rotated token needs the unit
  # bounced -- which is what restartUnits does on the activation that
  # rewrites the secret.
  sops.secrets."bosun-github-token" = {
    owner = "bosun";
    group = "bosun";
    mode = "0400";
    restartUnits = [ "bosun.service" ];
  };

  # The FHS family only. skiff-nixos would work here -- it shares whatever
  # host's /nix/store it boots on -- but "no Nix in the cloud" is about what a
  # job sees, and carrying the NixOS hull's closure would roughly double the
  # image this host is imported from for a family nothing in CI targets.
  services.bosun = {
    enable = true;
    repo = "jonpulsifer/infra";
    tokenFile = config.sops.secrets."bosun-github-token".path;

    # Ten warm slots against 48 vCPU: 10 x 4 vCPU plus the bench class's 4 is
    # 44, so ten jobs can run at once and each still gets four real cores.
    # Deliberately not deeper -- warm skiffs are idle and would oversubscribe
    # happily, but a benchmark whose jobs contend for cores measures the
    # contention rather than the runner. RAM is the other budget: 10 x 3 GiB
    # plus 16 GiB is 46 of 180 GB.
    classes.skiff-ubuntu = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      vcpus = 4;
      memory = "3072M";
      workspace = "6G";
      persist = true;
      warm = 10;
    };

    # The hosted-shaped bench class: 4 vCPU / 16 GiB, the exact spec of a
    # public-repo ubuntu-latest runner, so the benchmark's memory column
    # reads zero instead of 3-vs-16. Its 20 G workspace is also the only disk
    # here a cold `docker build` fits in. Exists for measurement; park it
    # (warm = 0) when nothing is being measured.
    classes.skiff-ubuntu-bench = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      vcpus = 4;
      memory = "16384M";
      workspace = "20G";
      persist = true;
      warm = 1;
    };

    # 30 GB of the boot disk for the actions/cache service. Measured on this
    # host with the repo's 614 MB bun store: 14 s restore against 49-76 s over
    # the internet.
    cache = {
      enable = true;
      maxSizeBytes = 32212254720;
    };

    # A host-local BuildKit every skiff builds through, so a layer cache
    # outlives the skiff that filled it. The one benchmark row the pool lost
    # was a cold image build -- 34 s against hosted's 25 s, registry-bound and
    # cold every time, because an ephemeral guest has no layers. This is the
    # same trade the cache service already makes for actions/cache.
    buildkit = {
      enable = true;
      maxSizeBytes = 42949672960; # 40 GB of layer cache
    };
  };

  # 180 GB total and nothing else on the box, so the bound is generous rather
  # than tight -- but it still exists, because without one the *host* OOM
  # killer picks the victim and on a spot instance that is a job either way.
  systemd.services.bosun.serviceConfig.MemoryMax = "150G";
}
