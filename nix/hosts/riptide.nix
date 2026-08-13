# riptide: folly worker node, rooted on NVMe. Also the first bosun host.
{ config, inputs, ... }:
{
  imports = [
    ../profiles/k8s-node.nix
    ../system/sops.nix
    ../system/tailscale-disable.nix
    ../../apps/bosun/module.nix
  ];

  services.k8s.clusterCa.enable = true;

  # simpledrm claims card0 early in boot and i915 replaces it with card1 a
  # second later, but udev leaves
  # /dev/dri/by-path/pci-...-platform-simple-framebuffer.0-card pointing at the
  # card0 that no longer exists. runc cannot recreate a symlink whose target is
  # missing, so every container handed the DRI directory — which is what the
  # Intel device plugin does for a gpu.intel.com/i915 claim — dies in
  # CreateContainerError. Prune the danglers before kubelet can start a pod.
  systemd.services.prune-dri-by-path = {
    description = "Remove dangling /dev/dri/by-path symlinks left by the simpledrm handover";
    wantedBy = [ "multi-user.target" ];
    before = [ "kubelet.service" ];
    unitConfig.ConditionPathIsDirectory = "/dev/dri/by-path";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      for link in /dev/dri/by-path/*; do
        [ -L "$link" ] || continue
        [ -e "$link" ] && continue
        echo "pruning dangling $link -> $(readlink "$link")"
        rm -f "$link"
      done
    '';
  };

  homelab.disko.device = "/dev/nvme0n1";

  sops.defaultSopsFile = ../secrets/riptide.sops.yaml;
  # bosun reads this once at startup, so a rotated key needs the unit
  # bounced -- which is what restartUnits does on the activation that
  # rewrites the secret. Shared with oldschool: both are bosun hosts on the
  # same Spindrift+bosun GitHub App, each holding this same key.
  sops.secrets."bosun-github-app-key" = {
    sopsFile = ../secrets/bosun.sops.yaml;
    owner = "bosun";
    group = "bosun";
    mode = "0400";
    restartUnits = [ "bosun.service" ];
  };

  # A skiff mounts this host's /nix/store, so the hull's closure has to be
  # here rather than merely buildable: naming the package is what puts it in
  # riptide's store.
  services.bosun = {
    enable = true;
    repo = "jonpulsifer/infra";
    github = {
      # The shared Spindrift+bosun GitHub App ("spindrift-lolwtf").
      appId = 4576122;
      privateKeyFile = config.sops.secrets."bosun-github-app-key".path;
    };
    classes.skiff-nixos = {
      hull = "${inputs.self.packages.x86_64-linux.hull-nixos}";
      vcpus = 4;
      memory = "2048M";
      warm = 1;
    };

    # A little one, for science: platform experiments that want a real skiff
    # without claiming real capacity. This site rides the satellite link, so
    # production CI labels are served from oldschool -- one small slot is the
    # agreed exception, not the start of a pool. 4G workspace, not 6G,
    # because the ~20 GiB free on this root also backs the 10G cache cap
    # below and skiff-ubuntu's parked slots: the standing reservation stays
    # small so the un-park arithmetic stays possible at all.
    classes.skiff-ubuntu-lite = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      vcpus = 1;
      memory = "2048M";
      workspace = "4G";
      warm = 1;
    };
    # The FHS family: apt, dockerd, and the ARC image's toolchain, no Nix.
    # A scratch disk carries the runner's workspace and docker's data root, so
    # `memory` here is a RAM figure and nothing else -- without one the guest
    # root is a tmpfs overlay and a checkout that outgrows the class is an OOM
    # rather than an ENOSPC. 6G is generous for this repo's real workload
    # (checkout, bun store, one build) and the two of them reserve 12 GiB of
    # the ~20 GiB free on riptide's root filesystem.
    #
    # warm = 2 is the point of the disk: the bench measured a second
    # skiff-ubuntu job waiting three minutes for the first to finish, which is
    # what blocks migrating anything real onto skiffs.
    #
    # persist is what closes the remaining gap to a hosted runner. That gap was
    # measured at 99 s on this repo's real suite and 70 s of it was
    # `actions/cache` pulling the dependency store over the internet -- so the
    # answer is not a faster transfer, it is no transfer. A slot the next skiff
    # finds already carrying the checkout, the bun store and the tool cache
    # removes it. `jonpulsifer/infra` runs no code from forks, which is the
    # condition that makes the trade sound; the option's own documentation is
    # where the reasoning lives.
    classes.skiff-ubuntu = {
      hull = "${inputs.self.packages.x86_64-linux.hull-ubuntu}";
      vcpus = 4;
      memory = "3072M";
      workspace = "6G";
      persist = true;
      # Parked, and not as spare capacity: a CI job's traffic -- checkout,
      # caches, docker pulls -- does not belong on this site's satellite
      # link, so oldschool serves skiff-ubuntu from the fast-internet site.
      # Un-parking is a last resort, not a rebalancing lever, and re-does
      # the disk arithmetic first as well as the memory's: two 6G slots
      # plus the lite slot's 4G plus a full 10G cache oversubscribe the
      # ~20 GiB free here. The slot disks are reclaimed at 0 and rebuilt
      # cold on the way back up.
      warm = 0;
    };

    # 10 GB on the NVMe root for the actions/cache service. Announced to
    # every skiff on this host; the parked class picks it up whenever it
    # un-parks, and skiff-nixos ignores it until that hull learns the trick.
    cache = {
      enable = true;
      maxSizeBytes = 10737418240;
    };
  };

  # The pool's declared ceiling is 2048M + 2048M with skiff-ubuntu parked,
  # well inside the limit below. Un-parking skiff-ubuntu at warm = 2 would
  # take the declared total to 10 GiB -- over this limit and over what the
  # host can spare (15.2 GiB total, ~5 GiB held by kubelet and the system,
  # no swap), so that last resort re-does this arithmetic first. Without a
  # bound the *host* OOM killer picks the victim, which on a worker node may
  # be a pod or kubelet rather than a skiff.
  #
  # Every skiff is a child of this unit, so the limit covers the whole pool
  # the same way IPAddressDeny does. Raising warm further is now a disk
  # question before it is a memory one -- see services.bosun.workspaceDir.
  systemd.services.bosun.serviceConfig.MemoryMax = "9G";
}
