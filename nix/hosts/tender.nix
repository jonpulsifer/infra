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

  sops.secrets."spindrift-pool-token" = {
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
  # Sized against c4-highmem-8's 8 vCPU / 62 GB, with no kubelet to share
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
      warm = 3;
    };

    # Image builds. A docker build lives in the guest's docker data root on
    # the workspace disk, and a fat image plus persisted layers of earlier
    # builds does not fit in 6G — the whole container matrix ENOSPCed there
    # (dpkg padding, buildkit "failed to reserve cache"). Same hull, same
    # RAM; only the disk differs, which is exactly what a class is for.
    classes.skiff-ubuntu-xl = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      vcpus = 4;
      memory = "3072M";
      workspace = "20G";
      persist = true;
      warm = 1;
    };

    # The hosted-shaped bench class: 4 vCPU / 16 GiB, the exact spec of a
    # public-repo ubuntu-latest runner, so the benchmark's memory column
    # reads zero instead of 3-vs-16. Exists for measurement; park it
    # (warm = 0) when nothing is being measured.
    classes.skiff-ubuntu-bench = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      vcpus = 4;
      memory = "16384M";
      workspace = "20G";
      persist = true;
      warm = 1;
    };

    # Spindrift builds. The xl sizing (an image build needs the 20G disk),
    # the build hull, and warm = 0 — a build skiff boots on claim, never
    # ahead of time. persist = false, deliberately: sweepWorkspaces keeps
    # persisted images only for slots < warm, so persist with warm = 0 is a
    # cache the next restart deletes. The cost is a cold docker layer cache
    # per build; the upgrade is a persist slot count independent of warm.
    classes.skiff-build-xl = {
      hull = "${inputs.self.packages.x86_64-linux.hull-build-ubuntu}";
      vcpus = 4;
      memory = "3072M";
      workspace = "20G";
      persist = false;
      warm = 0;
    };

    # The outage fallback this host exists to serve: long-poll Spindrift's
    # outbox and run claimed builds on skiff-build-xl. The hostname is a
    # path-scoped rule on the spindrift tunnel exposing /internal/bosun/
    # and nothing else (terraform/network/cloudflare/spindrift.tf) — the
    # control plane's own hostname is a LAN record a cloud host cannot
    # reach, and the tunnel address is public, outside the RFC1918 deny
    # bosun's unit carries.
    spindrift = {
      url = "https://spindrift-control.lolwtf.dev";
      tokenFile = config.sops.secrets."spindrift-pool-token".path;
      classes = [ "skiff-build-xl" ];
    };

    # 30 GB of the 130 GB boot disk for the actions/cache service; the
    # workspace disks (3x6G + 20G + 20G + 20G) reserve another 78 GB and the
    # closure needs the rest.
    cache = {
      enable = true;
      maxSizeBytes = 32212254720;
    };
  };

  # 30 GiB total and nothing else on the box, so the bound is generous rather
  # than tight -- but it still exists, because without one the *host* OOM
  # killer picks the victim and on a spot instance that is a job either way.
  systemd.services.bosun.serviceConfig.MemoryMax = "48G";
}
