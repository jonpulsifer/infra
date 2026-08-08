# The Ubuntu hull: an FHS guest with no Nix in it.
#
# This is the `ubuntu-latest`-fidelity family and the shape the cloud path
# boots. The rootfs is the repo's own ARC runner image — the exact filesystem
# every `runs-on: offsite` job already passes on — flattened into a read-only
# squashfs handed to the guest as a virtio-blk disk. Writes land in a tmpfs
# overlay upper, so a skiff still leaves nothing behind.
#
# Nix builds all of it, but none of it reaches the guest: no /nix/store, no
# store share, no Nix database. "No Nix in the cloud" is about the guest, not
# the builder.
#
# There is no systemd in here. PID 1 is busybox init running three inittab
# lines: bring the machine up, run one job, halt. The guest is a single-use
# machine running one job as root — the VM boundary is the isolation, not the
# user boundary inside it (same stance as hull-nixos).
{
  lib,
  pkgs,
}:
let
  # Same kernel derivation the NixOS hull boots, so riptide's store already
  # has it: the `dev` output's vmlinux carries the PVH entry note
  # cloud-hypervisor needs, and /lib/modules below comes from the same build.
  kernel = pkgs.linuxPackages.kernel;
  # depmod'd module tree from the kernel's split `modules` output: the raw
  # output carries no modules.dep, which both makeModulesClosure and the
  # guest's busybox modprobe need.
  modulesTree = pkgs.aggregateModules [ kernel.modules ];

  # The rootfs source of record: clusters/base/apps/arc/infra.yaml pins this
  # same image for the ARC runners, so "what does a job need installed?" is
  # already field-answered. Bump the digest when the cluster pin moves; a
  # stale pin still pulls, it is just older.
  runnerImage = pkgs.dockerTools.pullImage {
    imageName = "ghcr.io/jonpulsifer/actions-runner";
    imageDigest = "sha256:fcc546f5fb6e4fe048e3b28f0c20f4df2077ce0e51be5e55bf89262c6aa1fecf";
    sha256 = "sha256-mhFqK3vA/aQ+3ncQ2MNbQLuoPI8XrEEFaU7MevtFz1k=";
    os = "linux";
    arch = "amd64";
  };

  # dockerd inside the guest, version-matched to the NixOS hull's docker so
  # the two families never diverge on build behaviour. Static binaries: the
  # guest has Ubuntu's glibc, not nixpkgs', so nothing dynamic from nixpkgs
  # can run there.
  dockerStatic = pkgs.fetchurl {
    url = "https://download.docker.com/linux/static/stable/x86_64/docker-29.6.2.tgz";
    hash = "sha256-1iBK6pIjjiRT1URciFudLl64+CkVVo7FDt+dvhKjrHQ=";
  };

  busybox = pkgs.pkgsStatic.busybox;
  # dockerd shells out to iptables; the container-image rootfs has none.
  iptables = pkgs.pkgsStatic.iptables;

  # Everything stage-1 needs before there is a rootfs to load modules from.
  # The full module tree rides inside the rootfs for everything later (docker
  # pulls netfilter modules in on demand).
  modulesClosure = pkgs.makeModulesClosure {
    kernel = modulesTree;
    firmware = pkgs.emptyDirectory;
    rootModules = [
      "virtio_pci"
      "virtio_blk"
      "virtio_net"
      "virtio_rng"
      "squashfs"
      "overlay"
      "fuse"
      "virtiofs"
    ];
    allowMissing = false;
  };

  # Stage 1: mount the read-only rootfs, put a tmpfs overlay on top, attach
  # the credential share, and hand PID 1 to busybox init inside the overlay.
  stage1 = pkgs.writeScript "stage1" ''
    #!/bin/busybox sh
    bb=/bin/busybox
    $bb mount -t proc proc /proc
    $bb mount -t sysfs sysfs /sys
    $bb mount -t devtmpfs dev /dev
    for m in virtio_pci virtio_blk virtio_net virtio_rng squashfs overlay fuse virtiofs; do
      $bb modprobe $m
    done
    $bb mkdir -p /ro /rw /newroot
    $bb mount -t squashfs -o ro /dev/vda /ro
    $bb mount -t tmpfs -o mode=0755 tmpfs /rw
    $bb mkdir -p /rw/upper /rw/work
    $bb mount -t overlay -o lowerdir=/ro,upperdir=/rw/upper,workdir=/rw/work overlay /newroot
    $bb mount -t virtiofs -o ro bosun /newroot/run/bosun
    exec $bb switch_root /newroot /opt/bosun/busybox init
  '';

  initrd = pkgs.makeInitrd {
    contents = [
      {
        object = stage1;
        symlink = "/init";
      }
      {
        object = "${busybox}/bin/busybox";
        symlink = "/bin/busybox";
      }
      {
        object = "${modulesClosure}/lib/modules";
        symlink = "/lib/modules";
      }
    ];
  };

  # Stage 2, line 1: the machine. Mounts, hostname, DHCP from passt, dockerd
  # in the background — nothing here may block the runner longer than it must.
  setup = pkgs.writeScript "skiff-setup" ''
    #!/opt/bosun/busybox sh
    bb=/opt/bosun/busybox
    $bb mount -t proc proc /proc
    echo "skiff-mark setup-start $($bb cut -d' ' -f1 /proc/uptime)"
    $bb mount -t sysfs sysfs /sys
    $bb mount -t devtmpfs dev /dev
    $bb mkdir -p /dev/pts /dev/shm
    $bb mount -t devpts devpts /dev/pts
    $bb mount -t tmpfs shm /dev/shm
    $bb mount -t cgroup2 cgroup2 /sys/fs/cgroup

    $bb hostname skiff
    echo "127.0.0.1 localhost skiff" > /etc/hosts

    # The runner writes its trace to <runner root>/_diag. Everything else in
    # this guest is a tmpfs overlay that dies with the VM, so this one
    # directory is bound through to the host: a skiff killed mid-job leaves
    # the _diag behind on riptide instead of nothing at all.
    $bb mkdir -p /home/runner/_diag
    $bb mount -t virtiofs bosun-diag /home/runner/_diag

    $bb ip link set lo up
    $bb ip link set eth0 up
    $bb udhcpc -i eth0 -q -n -s /opt/bosun/udhcpc-script

    # A plain tmpfs: docker's overlayfs snapshotter cannot put upper/work
    # dirs on the root overlay itself (EINVAL on mount).
    $bb mkdir -p /var/lib/docker
    $bb mount -t tmpfs -o mode=0710 tmpfs /var/lib/docker
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      dockerd >/var/log/dockerd.log 2>&1 &
    echo "skiff-mark setup-done $($bb cut -d' ' -f1 /proc/uptime)"
  '';

  udhcpcScript = pkgs.writeScript "udhcpc-script" ''
    #!/opt/bosun/busybox sh
    bb=/opt/bosun/busybox
    case "$1" in
      bound|renew)
        $bb ifconfig "$interface" "$ip" netmask "''${subnet:-255.255.255.0}"
        [ -n "$router" ] && $bb route add default gw "$router" dev "$interface"
        $bb rm -f /etc/resolv.conf
        for d in $dns; do echo "nameserver $d" >> /etc/resolv.conf; done
        ;;
    esac
  '';

  # Stage 2, line 2: the one job this skiff was booted for. The runner
  # deregisters itself after one job and exits; this script then powers off,
  # which exits the VMM with 0 — the launcher's completion signal.
  run = pkgs.writeScript "skiff-run" ''
    #!/opt/bosun/busybox sh
    export HOME=/home/runner
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    export RUNNER_ALLOW_RUNASROOT=1
    # Read rather than passed as an argument: --jitconfig would put the
    # credential in every process listing inside the guest.
    export ACTIONS_RUNNER_INPUT_JITCONFIG="$(/opt/bosun/busybox cat /run/bosun/jitconfig)"
    cd /home/runner
    echo "skiff-mark runner-exec $(/opt/bosun/busybox cut -d' ' -f1 /proc/uptime)"
    # Not exec'd, and the poweroff lives here rather than in an inittab
    # `once` entry: measured on riptide, busybox init never reached the
    # `once` line after this wait entry finished, leaving a deregistered
    # guest running forever. The shell that ran the runner halts the machine.
    ./bin/Runner.Listener run
    echo "skiff-mark runner-exit $(/opt/bosun/busybox cut -d' ' -f1 /proc/uptime)"
    /opt/bosun/busybox poweroff -f
  '';

  inittab = pkgs.writeText "inittab" ''
    ::sysinit:/opt/bosun/setup
    ::wait:/opt/bosun/run
    ::ctrlaltdel:/opt/bosun/busybox poweroff -f
  '';

  rootfs =
    pkgs.runCommand "skiff-ubuntu-rootfs"
      {
        nativeBuildInputs = with pkgs; [
          jq
          squashfsTools
        ];
      }
      ''
        mkdir root
        tar -xf ${runnerImage} -C .

        # Flatten the OCI layers in manifest order, honouring whiteouts.
        for layer in $(jq -r '.[0].Layers[]' manifest.json); do
          # `|| true`: a layer with no whiteouts is normal, and stdenv's
          # pipefail would otherwise kill the build on grep's empty result.
          tar -tf "$layer" | { grep -E '(^|/)\.wh\.' || true; } | while read -r wh; do
            dir=$(dirname "$wh"); name=$(basename "$wh")
            if [ "$name" = ".wh..wh..opq" ]; then
              rm -rf "root/$dir"/{*,.[!.]*} 2>/dev/null || true
            else
              rm -rf "root/$dir/''${name#.wh.}"
            fi
          done
          tar -xf "$layer" -C root --no-same-owner --exclude='*/.wh.*' --exclude='.wh.*'
        done

        # dockerd, containerd, runc and friends.
        tar -xzf ${dockerStatic}
        install -m755 docker/* root/usr/local/bin/

        # Static iptables where dockerd's PATH will find it.
        mkdir -p root/usr/local/sbin
        cp -a ${iptables}/bin/. root/usr/local/sbin/

        # The full module tree, so docker can modprobe netfilter on demand.
        cp -a ${modulesTree}/lib/modules root/lib/
        # The kernel's own module loader must exist at the path the kernel
        # calls (request_module → /sbin/modprobe). The container image has no
        # kmod; busybox answers.
        [ -e root/sbin/modprobe ] || ln -sf /opt/bosun/busybox root/sbin/modprobe

        # Jobs written for ubuntu-latest say `sudo apt-get`, and they run as
        # root here. The image's sudoers grants only the `sudo` group (the
        # runner user) and includes no sudoers.d, so root needs its own line
        # in the main file.
        chmod u+w root/etc/sudoers
        echo 'root ALL=(ALL:ALL) NOPASSWD:ALL' >> root/etc/sudoers
        chmod 440 root/etc/sudoers

        mkdir -p root/opt/bosun root/run/bosun
        install -m755 ${busybox}/bin/busybox root/opt/bosun/busybox
        install -m755 ${setup} root/opt/bosun/setup
        install -m755 ${run} root/opt/bosun/run
        install -m755 ${udhcpcScript} root/opt/bosun/udhcpc-script
        install -m644 ${inittab} root/etc/inittab
        rm -f root/etc/resolv.conf

        # Modes the sandbox build cannot express on disk: tar umask-masks
        # sticky bits and chmod'ing setuid is forbidden in the sandbox, so
        # both are stamped into the squashfs instead of the staging tree.
        # ponytail: a hardcoded list; generate from the layer tars if more
        # setuid tools ever matter.
        printf '%s\n' \
          'tmp m 1777 0 0' \
          'var/tmp m 1777 0 0' \
          'usr/bin/sudo m 4755 0 0' \
          'usr/bin/su m 4755 0 0' \
          > pseudo.defs

        mkdir $out
        mksquashfs root $out/rootfs.img \
          -comp zstd -all-root -no-progress -noappend -processors $NIX_BUILD_CORES \
          -pf pseudo.defs
      '';

  manifest = {
    kernel = "vmlinux";
    initrd = "initrd";
    # loglevel=4: full dmesg to the serial file costs ~0.3 s of the ~1 s
    # boot; warnings still land. Raise it when debugging a boot.
    cmdline = "console=ttyS0 panic=-1 loglevel=4";
    devices = [
      {
        disk = {
          path = "rootfs.img";
          ro = true;
        };
      }
    ];
  };
in
# A hull is content-addressed by the launcher over this directory, so it
# carries no identity of its own.
pkgs.runCommand "hull-ubuntu" { preferLocalBuild = true; } ''
  mkdir -p $out
  ln -s ${kernel.dev}/vmlinux $out/vmlinux
  ln -s ${initrd}/initrd $out/initrd
  ln -s ${rootfs}/rootfs.img $out/rootfs.img
  ln -s ${pkgs.writeText "hull.json" (builtins.toJSON manifest)} $out/hull.json
''
