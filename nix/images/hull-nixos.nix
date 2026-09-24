# The NixOS hull a skiff boots: a kernel, an initrd and hull.json, no rootfs.
# The guest mounts the host's /nix/store read-only over virtiofs under a tmpfs
# overlay and runs one job as root; the VM is the isolation boundary.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (config.system.build) toplevel;

  # The host's Nix db is unreadable by an unprivileged virtiofsd, so the guest
  # registers this closure at boot; nix substitutes any path outside it.
  regInfo = pkgs.closureInfo { rootPaths = [ toplevel ]; };

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

    # The launcher boots the kernel directly.
    loader.grub.enable = false;

    # The store mount needs these in stage 1, and nothing probes a virtiofs tag
    # into existence, so they are loaded unconditionally.
    initrd.kernelModules = [
      "virtio_pci"
      "virtiofs"
      "overlay"
    ];

    # Without it the NIC waits for stage-2 udev, and so does everything that
    # wants the network.
    initrd.availableKernelModules = [ "virtio_net" ];
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

    # The launcher always shares credentials as tag `bosun`; the manifest does
    # not declare it.
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
    # bosun's passt forwards no ports into the guest, so nothing inbound reaches it.
    firewall.enable = false;
  };

  systemd.network.networks."10-skiff" = {
    matchConfig.Type = "ether";
    networkConfig.DHCP = "ipv4";
    linkConfig.RequiredForOnline = "routable";
  };

  # Loads the guest's Nix database before nix-daemon starts. From nixpkgs'
  # qemu-vm.nix, which cannot be imported without its QEMU launcher.
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

  # The runner exits after one job; poweroff-force then exits the VMM with
  # status 0, the launcher's completion signal.
  systemd.services.skiff-runner = {
    description = "the one job this skiff was booted for";
    wantedBy = [ "multi-user.target" ];
    requires = [ "run-bosun.mount" ];
    after = [
      "network-online.target"
      "run-bosun.mount"
    ];
    wants = [ "network-online.target" ];
    # The system profile, so jobs get `nix` and a login shell's PATH.
    path = [ "/run/current-system/sw" ];
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
      # --jitconfig would show the credential in every guest process listing, so the runner reads it from
      # the environment.
      ExecStart = pkgs.writeShellScript "skiff-runner" ''
        export ACTIONS_RUNNER_INPUT_JITCONFIG="$(< /run/bosun/jitconfig)"
        exec ${lib.getExe' pkgs.github-runner "Runner.Listener"} run
      '';
    };
  };

  # Actions routinely download dynamically-linked binaries from GitHub releases.
  programs.nix-ld.enable = true;

  virtualisation.docker.enable = true;

  documentation.enable = false;
  # The KVM clock is already correct.
  services.timesyncd.enable = false;
  # Nothing lives long enough to rotate, and its config check fails at boot.
  services.logrotate.enable = false;
  # docker.socket starts dockerd on first use, so it never delays runner
  # registration.
  systemd.services.docker.wantedBy = lib.mkForce [ ];

  system.build.hull = pkgs.runCommand "hull-nixos" { preferLocalBuild = true; } ''
    mkdir -p $out
    # The `dev` output, not `out`: cloud-hypervisor boots the unstripped ELF
    # directly over PVH, and only that one carries the entry note it needs.
    ln -s ${config.boot.kernelPackages.kernel.dev}/vmlinux $out/${manifest.kernel}
    ln -s ${config.system.build.initialRamdisk}/initrd $out/${manifest.initrd}
    ln -s ${pkgs.writeText "hull.json" (builtins.toJSON manifest)} $out/hull.json
  '';
}
