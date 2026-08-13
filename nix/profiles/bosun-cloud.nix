# A cloud bosun host: a GCE instance that keeps a warm pool of skiffs, without
# spending a folly worker's RAM to do it. Terraform is in
# terraform/gcp/projects/homelab-ng/bosun.tf.
#
# Everything that is the same on every cloud host lives here. What a host file
# sets is its pool depth, which is a function of how much silicon it bought.
#
# Two labels per host, deliberately:
#
#   skiff-ubuntu   shared by the whole fleet, so ordinary CI load-balances
#                  across every host and the pool's depth is the fleet's,
#                  not any one machine's.
#   skiff-<host>   one host only, so a benchmark can pin itself to a single
#                  silicon generation and the comparison means something.
#
# The image module supplies the disk layout; the hostname is the registry
# name, baked into the closure, which is what nixos-upgrade resolves.
{
  config,
  inputs,
  lib,
  ...
}:
let
  host = config.networking.hostName;
  hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
in
{
  imports = [
    ../images/gce.nix
    ../system/sops.nix
    ../../apps/bosun/module.nix
  ];

  options.bosunCloud = {
    warmUbuntu = lib.mkOption {
      type = lib.types.ints.positive;
      description = ''
        Warm slots this host keeps on the fleet-shared `skiff-ubuntu` label.
        Each holds 3 GiB of RAM and reserves 6 G of workspace up front, so
        this is bounded by the smaller of the two budgets.
      '';
    };
    memoryMax = lib.mkOption {
      type = lib.types.str;
      description = ''
        Ceiling for the bosun unit. Without one the *host* OOM killer picks
        the victim, and on a Spot instance that is a failed job either way.
        Leave the host itself a few GiB.
      '';
    };
  };

  config = {
    # Each host decrypts with its own SSH host key, so each carries its own
    # file. The name is the hostname because that is the only thing that
    # differs, and deriving it keeps a host file from having to repeat itself.
    sops.defaultSopsFile = ../secrets/${host}.sops.yaml;

    # bosun reads this once at startup, so a rotated token needs the unit
    # bounced -- which is what restartUnits does on the activation that
    # rewrites the secret.
    sops.secrets."bosun-github-token" = {
      owner = "bosun";
      group = "bosun";
      mode = "0400";
      restartUnits = [ "bosun.service" ];
    };

    services.bosun = {
      enable = true;
      repo = "jonpulsifer/infra";
      tokenFile = config.sops.secrets."bosun-github-token".path;

      # The FHS family only. skiff-nixos would work here -- it shares whatever
      # host's /nix/store it boots on -- but "no Nix in the cloud" is about
      # what a job sees, and carrying the NixOS hull's closure would roughly
      # double the image this host is imported from, for a family nothing in
      # CI targets.
      classes.skiff-ubuntu = {
        inherit hull;
        vcpus = 4;
        memory = "3072M";
        workspace = "6G";
        persist = true;
        warm = config.bosunCloud.warmUbuntu;
      };

      # The hosted-shaped bench class: 4 vCPU / 16 GiB, the exact spec of a
      # public-repo ubuntu-latest runner, so the benchmark's memory column
      # reads zero instead of 3-vs-16. One per host, each on its own label,
      # which is what makes the per-silicon comparison possible at all.
      # Exists for measurement; park it (warm = 0) when nothing is measured.
      classes."skiff-${host}" = {
        inherit hull;
        vcpus = 4;
        memory = "16384M";
        workspace = "20G";
        persist = true;
        warm = 1;
      };

      # 30 GB of the boot disk for the actions/cache service. Measured on
      # tender with this repo's 614 MB bun store: 14 s restore against 49-76 s
      # over the internet.
      cache = {
        enable = true;
        maxSizeBytes = 32212254720;
      };
    };

    systemd.services.bosun.serviceConfig.MemoryMax = config.bosunCloud.memoryMax;
  };
}
