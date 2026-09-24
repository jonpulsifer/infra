# The fleet registry. flake.nix derives every output from it through ../lib/registry.nix.
# Optional fields: system (build platform, default x86_64-linux); tags (Tailscale tags; "folly" or
# "offsite" sets a k8s node's cluster); kind (host, image or package, default host); baseline
# (overrides kind's default); module (default ./<name>.nix, callPackage'd for a package); artifact
# (the config.system.build attribute published as a package, unused for a package); packageSystem
# (the packages.<system> the result publishes under, default x86_64-linux).
{
  optiplex = {
    tags = [ "folly" ];
  };
  riptide = {
    tags = [ "folly" ];
  };
  shale = {
    tags = [ "folly" ];
  };

  oldschool = {
    tags = [ "offsite" ];
  };
  retrofit = {
    tags = [ "offsite" ];
  };

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

  # armv6l Pi Zero W, cross-compiled from aarch64-linux (../hardware/pi0.nix), so the
  # image publishes under aarch64-linux too.
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

  oldboy = {
    tags = [ "gcp" ];
    artifact = "googleComputeImage";
  };

  # Nothing deploys rackpi5: spore signs and serves it as forge's EEPROM HTTP boot fallback.
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

  # A skiff's kernel, initrd and boot manifest, built and launched on the same box.
  hull-nixos = {
    kind = "image";
    module = ../images/hull-nixos.nix;
    artifact = "hull";
  };

  # The FHS skiff: kernel, initrd and a flattened runner-image rootfs disk; the guest has no Nix.
  hull-ubuntu = {
    kind = "package";
    module = ../images/hull-ubuntu.nix;
  };

  # hull-ubuntu with a build script in place of the ARC runner.
  hull-build-ubuntu = {
    kind = "package";
    module = ../images/hull-build-ubuntu.nix;
  };

  # The PBX image both clusters run. `nix build .#asterisk-image` writes a script that streams
  # the image into `docker load`.
  asterisk-image = {
    kind = "package";
    module = ../images/asterisk.nix;
  };
}
