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

  # No defaultSopsFile: bosun's App key is the only secret this host holds and
  # it names its own file, which is shared with riptide and oldschool rather
  # than per-host. tender's own age recipient still has to be added to that
  # file after first boot -- the two-stage in
  # [[Runbooks/SOPS Secrets and Age Keys]] -- because the key it decrypts with
  # does not exist until the instance has booted once.
  #
  # bosun reads this once at startup, so a rotated key needs the unit bounced,
  # which is what restartUnits does on the activation that rewrites it.
  sops.secrets."bosun-github-app-key" = {
    sopsFile = ../secrets/bosun.sops.yaml;
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
    github = {
      # The shared Spindrift+bosun GitHub App ("spindrift-bot").
      appId = 4576122;
      privateKeyFile = config.sops.secrets."bosun-github-app-key".path;
    };

    # 4 vCPU / 16 GiB: a public-repo ubuntu-latest runner's exact spec, because
    # a pool that is not the same shape as the thing it replaces cannot be
    # compared to it. 3072M was riptide's number -- a folly worker sharing its
    # RAM with kubelet under a 9G ceiling -- and typescript.yml already carries
    # the note that the suite outgrew it. This host has 180 GB and no kubelet to
    # protect, so it inherits the constraint for no reason.
    #
    # Eight warm, which is what the budgets allow: 8 x 16 GiB plus the bench
    # slot's 16 is 144 of the unit's 150G ceiling, and 8 x 6G of workspace plus
    # the bench slot's 20G, the cache's 30G and the closure is ~123 GB of the
    # 200 GB disk. Eight busy jobs is 32 vCPU against 24 physical cores, so they
    # share hyperthreads at full tilt -- measured as costing nothing on this
    # suite, which is bound by its database rather than by cores.
    #
    # Standing caveat, widened rather than introduced here: `skiff-ubuntu` is
    # one label across hosts that are not one machine -- oldschool serves it at
    # 2 vCPU / 3 GiB, guarding a box it shares with kubelet. A job takes
    # whichever slot is free, so a measurement on this label has to read the
    # runner name to know what it landed on; the benchmark's `overhead` job
    # prints cores and memory for exactly that reason.
    classes.skiff-ubuntu = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      vcpus = 4;
      memory = "16384M";
      workspace = "6G";
      persist = true;
      warm = 8;
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
