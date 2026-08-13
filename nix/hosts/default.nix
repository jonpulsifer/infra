# The fleet registry: one entry per NixOS closure this repo builds.
#
# This is the only list. `flake.nix` maps it into `nixosConfigurations`,
# `packages`, `checks`, and the deploy-host list for the `nix run` apps — none
# of those are maintained by hand, so none of them can drift from each other.
#
# Fields, all optional:
#   system        build platform (default "x86_64-linux")
#   tags          Tailscale ACL tags. For a k8s node, the cluster tag ("folly"
#                 or "offsite") is also what selects its cluster — see
#                 ../profiles/k8s-node.nix.
#   kind          "host" (deployable, gets the fleet baseline), "image"
#                 (built and flashed/imported, gets only ../profiles/base.nix),
#                 or "package" (a plain derivation, no NixOS closure at all:
#                 `module` is callPackage'd and `artifact` does not apply)
#   baseline      override the baseline implied by `kind`
#   module        the configuration (default ./<name>.nix)
#   artifact      attribute under config.system.build to expose as a package
#   packageSystem which packages.<system> the artifact is published under
#                 (default "x86_64-linux"; see the note in flake.nix)
{
  # ── folly: on-site Kubernetes ──────────────────────────────────────────────
  optiplex = {
    tags = [ "folly" ];
  };
  riptide = {
    tags = [ "folly" ];
  };
  shale = {
    tags = [ "folly" ];
  };

  # ── offsite: remote-site Kubernetes ────────────────────────────────────────
  oldschool = {
    tags = [ "offsite" ];
  };
  retrofit = {
    tags = [ "offsite" ];
  };

  # ── lab Raspberry Pis ──────────────────────────────────────────────────────
  cloudpi4 = {
    system = "aarch64-linux";
    artifact = "sdImage";
  };
  homepi4 = {
    system = "aarch64-linux";
    artifact = "sdImage";
  };
  weatherpi4 = {
    system = "aarch64-linux";
    artifact = "sdImage";
  };
  capsule = {
    system = "aarch64-linux";
    artifact = "sdImage";
  };
  forge = {
    system = "aarch64-linux";
    tags = [ "lab-host" ];
    artifact = "sdImage";
  };
  spore = {
    system = "aarch64-linux";
    artifact = "sdImage";
  };

  # armv6l Pi Zero W: no native builder or cache exists for this arch, so these
  # are cross-compiled (../hardware/pi0.nix sets nixpkgs.crossSystem) on forge,
  # hence the aarch64-linux build platform matching forge's native architecture
  # — and hence the aarch64 package alias, unlike every other Pi below.
  radiopi0 = {
    system = "aarch64-linux";
    artifact = "sdImage";
    packageSystem = "aarch64-linux";
  };
  blinkypi0 = {
    system = "aarch64-linux";
    artifact = "sdImage";
    packageSystem = "aarch64-linux";
  };

  # ── cloud ──────────────────────────────────────────────────────────────────
  oldboy = {
    tags = [ "gcp" ];
    artifact = "googleComputeImage";
  };

  # The cloud bosun fleet: one host per silicon generation, each keeping a
  # warm pool of skiffs. They differ only in how much machine they bought --
  # see nix/profiles/bosun-cloud.nix and the fleet map in
  # terraform/gcp/projects/homelab-ng/bosun.tf.
  tender = {
    tags = [ "gcp" ];
    artifact = "googleComputeImage";
  };

  dinghy = {
    tags = [ "gcp" ];
    artifact = "googleComputeImage";
  };

  launch = {
    tags = [ "gcp" ];
    artifact = "googleComputeImage";
  };

  # ── images ─────────────────────────────────────────────────────────────────
  # rackpi5 is the image-only source for spore's native-boot publisher. Forge's
  # EEPROM keeps this signed HTTP/RAM artifact as its fallback path, so the full
  # toplevel is still built even though nothing deploys to it.
  rackpi5 = {
    system = "aarch64-linux";
    kind = "image";
    artifact = "piBootImg";
  };

  iso = {
    kind = "image";
    baseline = "fleet";
    module = ../images/iso.nix;
    artifact = "isoImage";
  };
  netboot = {
    kind = "image";
    baseline = "fleet";
    module = ../images/netboot.nix;
    artifact = "netbootBundle";
  };
  wsl = {
    kind = "image";
    module = ../images/wsl.nix;
    artifact = "tarballBuilder";
  };
  container = {
    kind = "image";
    module = ../images/container.nix;
    artifact = "tarball";
  };
  gce = {
    kind = "image";
    module = ../images/gce.nix;
    artifact = "googleComputeImage";
  };

  # A skiff's kernel and initrd, plus the manifest that says how to boot them.
  # Built and launched on the same box; nothing deploys it.
  hull-nixos = {
    kind = "image";
    module = ../images/hull-nixos.nix;
    artifact = "hull";
  };

  # The FHS skiff: kernel, initrd, and a flattened runner-image rootfs disk.
  # Not a NixOS closure — the guest carries no Nix at all.
  hull-ubuntu = {
    kind = "package";
    module = ../images/hull-ubuntu.nix;
  };

  # The Ubuntu hull's build variant: same rootfs and boot plumbing, a
  # Spindrift build script in place of the ARC runner.
  hull-build-ubuntu = {
    kind = "package";
    module = ../images/hull-build-ubuntu.nix;
  };
}
