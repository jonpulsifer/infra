# tender: a Google Compute Engine bosun host. A tender is the boat that
# services the ship; this one keeps the warm pool that riptide keeps today,
# without spending a folly worker's RAM to do it.
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
  #
  # Sized against c4-standard-8's 8 vCPU / 30 GB, with no kubelet to share
  # with: 4x3072M is 12 GiB of the pool's declared ceiling, and 4x6G of
  # workspace is reserved up front out of the 100 GB boot disk. warm = 4 is
  # double what riptide can hold, which is the point -- concurrency, not
  # speed, is what the bench found blocking migration.
  services.bosun = {
    enable = true;
    repo = "jonpulsifer/infra";
    tokenFile = config.sops.secrets."bosun-github-token".path;
    classes.skiff-ubuntu = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      vcpus = 4;
      memory = "3072M";
      workspace = "6G";
      persist = true;
      warm = 4;
    };

    # 30 GB of the 100 GB boot disk for the actions/cache service; the four
    # workspace disks reserve another 24 GB and the closure needs the rest.
    cache = {
      enable = true;
      maxSizeBytes = 32212254720;
    };
  };

  # 30 GiB total and nothing else on the box, so the bound is generous rather
  # than tight -- but it still exists, because without one the *host* OOM
  # killer picks the victim and on a spot instance that is a job either way.
  systemd.services.bosun.serviceConfig.MemoryMax = "24G";
}
