# The NixOS hull: what a skiff boots.
#
# A hull is a directory holding a kernel, an initrd, and a `hull.json` beside
# them declaring how to boot and what host resources to share in. The launcher
# reads the manifest and translates it to cloud-hypervisor arguments; it never
# learns what any of it means.
#
# This family carries no rootfs. It shares the host's /nix/store read-only over
# virtiofs and layers a tmpfs overlay on top, so everything the guest runs is
# already on the host and `nix build` still works in the guest. That store
# arrives without a Nix database, so the closure's registration is loaded at
# boot from a path the cmdline names — the mechanism nixpkgs' own VM tests use.
#
# The guest is a single-use machine running one job as root: the VM boundary is
# the isolation, not the user boundary inside it.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (config.system.build) toplevel;

  # The store share carries no /nix/var/nix/db — the host's is 0600 root:root
  # and unreadable by an unprivileged virtiofsd. The guest builds its own from
  # this instead, which bounds the warm-store benefit to the declared closure:
  # paths outside it are visible but unregistered, so nix substitutes them.
  regInfo = pkgs.closureInfo { rootPaths = [ toplevel ]; };

  # The virtiofs tag the manifest declares for the store, matched by
  # fileSystems."/nix/.ro-store" below. The credential share arrives as tag
  # `bosun` whether a hull asks for it or not — that one is fixed by the
  # contract, and where it lands in the guest is this hull's choice.
  storeTag = "ro-store";

  runnerRoot = "/var/lib/skiff";

  manifest = {
    kernel = "vmlinux";
    initrd = "initrd";
    cmdline = lib.concatStringsSep " " (
      config.boot.kernelParams
      ++ [
        "init=${toplevel}/init"
        "regInfo=${regInfo}/registration"
      ]
    );
    devices = [
      {
        share = {
          tag = storeTag;
          host = builtins.storeDir;
          ro = true;
        };
      }
    ];
  };
in
{
  boot = {
    kernelParams = [ "console=ttyS0" ];

    # Nothing installs a bootloader: the launcher boots the kernel directly.
    loader.grub.enable = false;

    # Everything the root store mount needs, before there is a store to load
    # modules from. Forced rather than available: nothing probes a virtiofs tag
    # into existence.
    initrd.kernelModules = [
      "virtio_pci"
      "virtiofs"
      "overlay"
    ];
  };

  fileSystems = {
    "/" = {
      device = "tmpfs";
      fsType = "tmpfs";
      options = [ "mode=0755" ];
    };

    "/nix/.ro-store" = {
      device = storeTag;
      fsType = "virtiofs";
      options = [ "ro" ];
      neededForBoot = true;
    };

    "/nix/.rw-store" = {
      fsType = "tmpfs";
      options = [ "mode=0755" ];
      neededForBoot = true;
    };

    "/nix/store".overlay = {
      lowerdir = [ "/nix/.ro-store" ];
      upperdir = "/nix/.rw-store/upper";
      workdir = "/nix/.rw-store/work";
    };

    "/run/bosun" = {
      device = "bosun";
      fsType = "virtiofs";
      options = [ "ro" ];
    };
  };

  swapDevices = [ ];

  networking = {
    hostName = "skiff";
    useNetworkd = true;
    useDHCP = false;
    # The launcher denies RFC1918 for every skiff, so there is no LAN to
    # discover and nothing resolvable on it.
    firewall.enable = false;
  };

  systemd.network.networks."10-skiff" = {
    matchConfig.Type = "ether";
    networkConfig.DHCP = "ipv4";
    linkConfig.RequiredForOnline = "routable";
  };

  # The guest's Nix database, written straight to SQLite before anything can
  # ask Nix a question. Lifted from nixpkgs' qemu-vm.nix, which cannot be
  # imported here without its QEMU launcher.
  systemd.services.register-nix-paths = {
    unitConfig.DefaultDependencies = false;
    wantedBy = [ "sysinit.target" ];
    before = [
      "sysinit.target"
      "shutdown.target"
      "nix-daemon.socket"
      "nix-daemon.service"
    ];
    after = [ "local-fs.target" ];
    conflicts = [ "shutdown.target" ];
    restartIfChanged = false;
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      if [[ "$(cat /proc/cmdline)" =~ regInfo=([^ ]*) ]]; then
        ${lib.getExe' config.nix.package.out "nix-store"} --load-db < "''${BASH_REMATCH[1]}"
      fi
    '';
  };

  # Clause three of the hull's promise. The runner deregisters itself after one
  # job and exits; poweroff-force then exits the VMM with status 0, which is
  # how the launcher learns the skiff is finished.
  systemd.services.skiff-runner = {
    description = "the one job this skiff was booted for";
    wantedBy = [ "multi-user.target" ];
    requires = [ "run-bosun.mount" ];
    after = [
      "network-online.target"
      "run-bosun.mount"
    ];
    wants = [ "network-online.target" ];
    path = with pkgs; [
      bash
      coreutils
      curl
      git
      gnutar
      gzip
      docker
    ];
    environment = {
      RUNNER_ROOT = runnerRoot;
      HOME = runnerRoot;
      RUNNER_ALLOW_RUNASROOT = "1";
    };
    unitConfig = {
      SuccessAction = "poweroff-force";
      FailureAction = "poweroff-force";
    };
    serviceConfig = {
      Type = "simple";
      StateDirectory = "skiff";
      WorkingDirectory = runnerRoot;
      # Read rather than passed as an argument: --jitconfig would put the
      # credential in every process listing inside the guest.
      ExecStart = pkgs.writeShellScript "skiff-runner" ''
        export ACTIONS_RUNNER_INPUT_JITCONFIG="$(< /run/bosun/jitconfig)"
        exec ${lib.getExe' pkgs.github-runner "Runner.Listener"} run
      '';
    };
  };

  # Actions routinely download dynamically-linked binaries from GitHub releases.
  programs.nix-ld.enable = true;

  virtualisation.docker.enable = true;

  # A hull is content-addressed by the launcher over this directory, so it
  # carries no identity of its own.
  system.build.hull = pkgs.runCommand "hull-nixos" { preferLocalBuild = true; } ''
    mkdir -p $out
    # The `dev` output, not `out`: cloud-hypervisor boots the unstripped ELF
    # directly over PVH, and only that one carries the entry note it needs.
    ln -s ${config.boot.kernelPackages.kernel.dev}/vmlinux $out/${manifest.kernel}
    ln -s ${config.system.build.initialRamdisk}/initrd $out/${manifest.initrd}
    ln -s ${pkgs.writeText "hull.json" (builtins.toJSON manifest)} $out/hull.json
  '';
}
