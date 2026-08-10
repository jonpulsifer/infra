# The Ubuntu hull: an FHS guest with no Nix in it.
#
# This is the `ubuntu-latest`-fidelity family and the shape the cloud path
# boots. The rootfs is the repo's own ARC runner image — the exact filesystem
# every `runs-on: offsite` job already passes on — flattened into a read-only
# squashfs handed to the guest as a virtio-blk disk. Writes land in a tmpfs
# overlay upper, so a skiff still leaves nothing behind. Where the class sizes
# a scratch disk, the workspace and docker's data root move onto it instead, so
# a build's bytes stop being charged against the class's memory.
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
  # "runner" boots the ARC runner (`Runner.Listener run`, the default and the
  # only thing this file built before this parameter existed). "build" swaps
  # in a script that runs a Spindrift build instead — same kernel, same
  # initrd, same setup, same squashfs assembly; only the run script and one
  # extra rootfs binary (buildx) differ, so that plumbing stays one source of
  # truth for both.
  variant ? "runner",
}:
let
  isBuild = variant == "build";
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

  # The build variant's one extra binary: a static buildx plugin, since the
  # runner image carries the docker CLI but not buildx. Upstream's release
  # binary, not pkgs.docker-buildx — that one is glibc-dynamic against
  # nixpkgs' glibc, which does not exist in this Ubuntu guest (see the
  # dockerStatic comment above).
  buildxPlugin = pkgs.fetchurl {
    url = "https://github.com/docker/buildx/releases/download/v0.30.1/buildx-v0.30.1.linux-amd64";
    hash = "sha256-w3EU/NA0Al7GjiJGV8ilqFDfRy3tPdy8p1rTp+u5cQ0=";
  };

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
    # devtmpfs carries no fd symlinks; full distros get them from their init.
    # bash process substitution (<(...)) opens /dev/fd/N, so without these the
    # build script dies at its first jq-fed while loop.
    $bb ln -sf /proc/self/fd /dev/fd
    $bb ln -sf /proc/self/fd/0 /dev/stdin
    $bb ln -sf /proc/self/fd/1 /dev/stdout
    $bb ln -sf /proc/self/fd/2 /dev/stderr

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

    # The scratch disk, when the class sized one. bosun appends it after
    # every disk this hull declared and names it on the cmdline, because an
    # index shifts with what the hull declared and a name does not.
    #
    # Formatting is this hull's business: bosun hands over a raw device and
    # never learns what goes on it, the same seam that lets the rootfs above
    # be a squashfs. That seam is also what makes a warm disk work without
    # bosun growing an opinion: a class that persists hands the same image to
    # successive skiffs, and the *guest* decides whether what it finds on it is
    # a filesystem worth keeping.
    #
    # The runner's workspace, docker's data root and a cache directory land
    # here, which is what takes them off the class's memory: without a disk
    # they are tmpfs, and `memory` is the disk budget.
    work=$($bb sed -n 's/.*bosun\.workspace=\([^ ]*\).*/\1/p' /proc/cmdline)
    $bb mkdir -p /var/lib/docker /home/runner/_work
    if [ -n "$work" ]; then
      $bb modprobe ext4
      $bb mkdir -p /mnt/skiff
      # Format only when the disk will not mount, which is the one test that
      # answers both cases bosun can hand over: a freshly reserved image is
      # zeroes and cannot mount, and a persisted slot image arrives with the
      # last skiff's filesystem on it. Lazy init because a filesystem this
      # guest creates is one nobody is left to benefit from an eager inode
      # table on.
      $bb mount -t ext4 "$work" /mnt/skiff 2>/dev/null || {
        /usr/sbin/mkfs.ext4 -Fq -m0 -E lazy_itable_init=1,lazy_journal_init=1,nodiscard "$work"
        $bb mount -t ext4 "$work" /mnt/skiff
      }
      # A cache is worth keeping right up to the point where it stops fitting.
      # Past that every skiff after this one fails on ENOSPC, so the guest that
      # finds the disk nearly full is the one that resets it -- there is nobody
      # else who could, since bosun never mounts it. df's columns: 2 is 1K
      # blocks, 4 is available.
      set -- $($bb df -k /mnt/skiff | $bb tail -1)
      if [ -n "$4" ] && [ "$4" -lt $(( $2 / 5 )) ]; then
        echo "skiff-mark workspace-reset $4 of $2 KiB free"
        $bb umount /mnt/skiff
        /usr/sbin/mkfs.ext4 -Fq -m0 -E lazy_itable_init=1,lazy_journal_init=1,nodiscard "$work"
        $bb mount -t ext4 "$work" /mnt/skiff
      fi
      # docker keeps its layer store across skiffs and loses everything mutable.
      #
      # The split matters in both directions. A skiff killed mid-job leaves
      # container and network metadata that dockerd would try to restore into a
      # machine that is not the one that wrote it, and a job's service container
      # carries a name GitHub generated for a job that is over -- so `containers`
      # and `network` go. `image` and `overlay2` are pulled bytes and nothing
      # else: keeping them is what stopped this hull paying 25 s to pull
      # `postgres:18-alpine` on every single job, measured against 20 s on a
      # GitHub-hosted runner that has it seeded.
      #
      # ponytail: deleting `containers` orphans its entries under
      # image/overlay2/layerdb/mounts, which docker tolerates and its own gc
      # collects. The reset-when-nearly-full rule above is the backstop; a real
      # `docker system prune` needs a dockerd that is already up, which races
      # the job this guest booted to run.
      $bb rm -rf /mnt/skiff/docker/containers /mnt/skiff/docker/network /mnt/skiff/docker/tmp
      $bb mkdir -p /mnt/skiff/work /mnt/skiff/docker /mnt/skiff/cache
      $bb chmod 0710 /mnt/skiff/docker
      $bb mount -o bind /mnt/skiff/work /home/runner/_work
      $bb mount -o bind /mnt/skiff/docker /var/lib/docker
      # What a job may keep between skiffs. Announced as one environment
      # variable rather than as a path a workflow has to know, because the
      # honest reading of "is there a warm cache here" is "did the hull set
      # this" -- a class with no disk, or one that does not persist, sets
      # nothing and a workflow falls back to whatever it does on a hosted
      # runner. `run` below is what puts it in the runner's environment.
      #
      # The runner's tool cache is named explicitly rather than left to default.
      # Measured: `_work/_tool` stayed at 4 KiB across warm jobs while setup-bun
      # kept paying to download, because with AGENT_TOOLSDIRECTORY unset the
      # runner puts its tool cache somewhere on the root overlay -- which is
      # tmpfs, so it costs the class's memory *and* is gone next boot. Naming it
      # here rather than in a workflow makes it a property of the machine, which
      # is what it is: the runner reads it before any job exists.
      $bb mkdir -p /mnt/skiff/tools /mnt/skiff/cache/bun /mnt/skiff/cache/xdg
      {
        echo 'export SKIFF_CACHE=/mnt/skiff/cache'
        echo 'export RUNNER_TOOL_CACHE=/mnt/skiff/tools'
        echo 'export AGENT_TOOLSDIRECTORY=/mnt/skiff/tools'
        # $HOME is the tmpfs root, so a tool cache written there is charged
        # against the class's memory -- bun's store alone is ~1.5G, which
        # ENOSPCed the first unmodified workflow this pool served (measured:
        # typescript.yml, bun extracting its own platform packages). A hosted
        # runner's $HOME is a 90G SSD; fidelity here means big caches land on
        # the disk without the workflow having to know.
        echo 'export BUN_INSTALL_CACHE_DIR=/mnt/skiff/cache/bun'
        echo 'export XDG_CACHE_HOME=/mnt/skiff/cache/xdg'
      } > /etc/skiff-env
    else
      # A plain tmpfs: docker's overlayfs snapshotter cannot put upper/work
      # dirs on the root overlay itself (EINVAL on mount).
      $bb mount -t tmpfs -o mode=0710 tmpfs /var/lib/docker
    fi
    # The host-local actions/cache service, when this host runs one. The
    # runner's Worker is patched at build time (see the squashfs staging) so
    # this env-provided URL survives into jobs and the stock actions/cache
    # talks to the local server instead of GitHub's. No announcement, no
    # override: the skiff behaves exactly as the hosted runner does.
    for tok in $($bb cat /proc/cmdline); do
      case "$tok" in
        bosun.cache=*) echo "export ACTIONS_RESULTS_URL=''${tok#bosun.cache=}" >> /etc/skiff-env ;;
      esac
    done
    echo "skiff-mark workspace-ready $($bb cut -d' ' -f1 /proc/uptime)"
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
        # passt copies the host's addressing, and on GCE that is a /32 with an
        # on-link gateway -- the router sits outside the interface's prefix, so
        # a bare default route is refused. A host route to the gateway first
        # makes it legal on both shapes of subnet.
        [ -n "$router" ] && {
          $bb ip route add "$router" dev "$interface" 2>/dev/null
          $bb ip route add default via "$router" dev "$interface"
        }
        $bb rm -f /etc/resolv.conf
        for d in $dns; do echo "nameserver $d" >> /etc/resolv.conf; done
        ;;
    esac
  '';

  # Stage 2, line 2: the one job this skiff was booted for. The runner
  # deregisters itself after one job and exits; this script then powers off,
  # which exits the VMM with 0 — the launcher's completion signal.
  runnerRun = pkgs.writeScript "skiff-run" ''
    #!/opt/bosun/busybox sh
    export HOME=/home/runner
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    export RUNNER_ALLOW_RUNASROOT=1
    # Whatever setup decided this skiff may keep between jobs, or nothing. The
    # runner hands its own environment down to every step, so a variable
    # exported here is a variable a workflow can read.
    [ -f /etc/skiff-env ] && . /etc/skiff-env
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

  # The build variant's stage 2, line 2: a Spindrift build instead of a job.
  # Real bash, not busybox sh — this needs curl/tar/jq/docker from the
  # Ubuntu rootfs, none of which busybox's ash can call into meaningfully
  # more than by exec'ing them anyway. Every line printed is captured to
  # $diag/result/build.log (see the setup script's bosun-diag mount), and
  # the EXIT trap is what keeps the two invariants this hull's wait entry
  # depends on: /home/runner/_diag/result/status always gets written, and
  # the VM always powers off, on every exit path — not just the ones this
  # script anticipated (same reasoning as the runner variant's poweroff
  # placement above).
  buildRun = pkgs.writeScript "skiff-build" ''
    #!/bin/bash
    # Stage 2, line 2 for the build variant: fetch the bundle §5 staged, run it
    # through the same frontend ladder spindrift-build.yml runs on GitHub's own
    # runners, and push. Everything printed here — including the marker line
    # core reads — is captured to $diag/result/build.log as well as the serial
    # console, and $diag/result/status is the one file that always lands: this
    # trap is what makes "always write a status, always power off" true on every
    # exit path, not just the ones this script anticipated.
    set -euo pipefail
    export HOME=/home/runner
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    [ -f /etc/skiff-env ] && . /etc/skiff-env

    diag=/home/runner/_diag
    result="$diag/result"
    mkdir -p "$result"

    status_written=0
    write_status() {
      printf '%s' "$1" > "$result/status"
      status_written=1
    }
    finish() {
      rc=$?
      if [ "$status_written" -eq 0 ]; then
        if [ "$rc" -eq 0 ]; then write_status SUCCEEDED; else write_status FAILED; fi
      fi
      # Flush the log through virtiofs before the VMM dies: poweroff -f gives
      # the page cache no chance on its own, and the report marker is the last
      # line of exactly this file.
      sync
      /opt/bosun/busybox poweroff -f
    }
    trap finish EXIT

    # Straight into the log file, not through a tee to the console: a tee is a
    # background process poweroff -f races, and losing its unflushed tail
    # loses the marker line. The log reaches the operator through the diag
    # share and the posted result; the serial console keeps the setup script's
    # boot marks.
    exec > "$result/build.log" 2>&1
    echo "skiff-mark build-start $(cut -d' ' -f1 /proc/uptime)"

    req=/run/bosun/request.json
    if [ ! -f "$req" ]; then
      echo "skiff-build: missing $req" >&2
      exit 1
    fi

    bundle_digest=$(jq -r '.source.bundleDigest' "$req")
    location=$(jq -r '.source.origin.location' "$req")
    subpath=$(jq -r '.source.origin.subpath // ""' "$req")
    artifact_type=$(jq -r '.spec.artifactType // "image"' "$req")
    frontend=$(jq -r '.spec.zeroConfigFrontend // ""' "$req")
    destination=$(jq -r '.spec.destinations[0]' "$req")
    # spec.platform arrives as either an OCI-shaped object or a plain
    # "os/arch" string; buildx wants the string either way.
    platform=$(jq -r '
      .spec.platform as $p
      | if ($p == null) then ""
        elif ($p | type) == "string" then $p
        elif ($p | type) == "object" then (($p.os // "linux") + "/" + ($p.architecture // $p.arch // "amd64"))
        else "" end
    ' "$req")

    # The workspace mount setup carved out of the scratch disk when the class
    # sized one (see skiff-setup); a class with no disk still made the mount
    # point, so /tmp is only ever a fallback for a boot that skipped setup.
    workdir=/home/runner/_work
    [ -d "$workdir" ] || workdir=/tmp
    build_root="$workdir/build"
    mkdir -p "$build_root"

    echo "skiff-mark bundle-fetch $(cut -d' ' -f1 /proc/uptime)"
    bundle_file="$build_root/bundle.tar.gz"
    curl --fail --silent --show-error --location -o "$bundle_file" "$location"

    want="''${bundle_digest#sha256:}"
    got="$(sha256sum "$bundle_file" | cut -d' ' -f1)"
    if [ "$want" != "$got" ]; then
      echo "skiff-build: bundle digest mismatch: want $want got $got" >&2
      exit 1
    fi

    bundle_root="$build_root/bundle"
    mkdir -p "$bundle_root"
    tar -xzf "$bundle_file" -C "$bundle_root"

    # §5's unwrap: a bundle whose root is exactly one directory has that
    # directory as its real root — the same rule spindrift-build.yml applies.
    root="$bundle_root"
    shopt -s dotglob nullglob
    entries=("$root"/*)
    if [ "''${#entries[@]}" -eq 1 ] && [ -d "''${entries[0]}" ]; then
      root="''${entries[0]}"
    fi
    shopt -u dotglob nullglob
    scope="$root/$subpath"

    # setup backgrounds dockerd; wait for the socket rather than racing it.
    # The runner variant never needed this because Runner.Listener's own
    # startup and job assignment mask the daemon's.
    for _ in $(seq 1 100); do
      docker version >/dev/null 2>&1 && break
      /opt/bosun/busybox sleep 0.2
    done
    if ! docker version >/dev/null 2>&1; then
      echo "skiff-build: dockerd never came up" >&2
      exit 1
    fi

    echo "skiff-mark registry-login $(cut -d' ' -f1 /proc/uptime)"
    auth_count=$(jq -r '(.spec.registryAuth // []) | length' "$req")
    for ((i = 0; i < auth_count; i++)); do
      host=$(jq -r ".spec.registryAuth[$i].host" "$req")
      username=$(jq -r ".spec.registryAuth[$i].username" "$req")
      jq -r ".spec.registryAuth[$i].secret" "$req" | docker login "$host" --username "$username" --password-stdin
    done

    echo "skiff-mark frontend-select $(cut -d' ' -f1 /proc/uptime)"
    frontend_build_arg=""
    if [ "$artifact_type" = "files" ]; then
      # A `files` artifact is not built at all — see spindrift-build.yml's
      # "Choose the frontend" step for why `FROM scratch` + `COPY . /` is
      # what makes the scope itself the pushed layer.
      dockerfile="$build_root/Dockerfile.files"
      printf 'FROM scratch\nCOPY . /\n' > "$dockerfile"
      context="$scope"
      file="$dockerfile"
    elif [ -f "$scope/Dockerfile" ]; then
      # ponytail: skips the workflow's COPY/ADD context-sniffing probe and
      # always builds from the bundle root; upgrade to the probe in
      # spindrift-build.yml's "Choose the frontend" step if a scoped
      # Dockerfile that expects its own directory as context shows up here.
      context="$root"
      file="$scope/Dockerfile"
    else
      plan_dir="$build_root/railpack-plan"
      mkdir -p "$plan_dir"
      docker run --rm \
        -v "$scope:/scope:ro" -v "$plan_dir:/out" \
        --entrypoint /railpack "$frontend" \
        prepare /scope --plan-out /out/railpack-plan.json
      context="$scope"
      file="$plan_dir/railpack-plan.json"
      frontend_build_arg="BUILDKIT_SYNTAX=$frontend"
    fi

    build_arg_flags=()
    while IFS= read -r kv; do
      [ -n "$kv" ] && build_arg_flags+=(--build-arg "$kv")
    done < <(jq -r '(.spec.buildArgs // {}) | to_entries[] | "\(.key)=\(.value)"' "$req")
    [ -n "$frontend_build_arg" ] && build_arg_flags+=(--build-arg "$frontend_build_arg")

    tag_flags=()
    while IFS= read -r t; do
      [ -n "$t" ] && tag_flags+=(-t "$t")
    done < <(jq -r '.spec.destinations[] as $d | (.spec.tags // ["latest"])[] | $d + ":" + .' "$req")

    platform_flags=()
    [ -n "$platform" ] && platform_flags=(--platform "$platform")

    echo "skiff-mark build-push $(cut -d' ' -f1 /proc/uptime)"
    metadata_file="$build_root/metadata.json"
    docker buildx build \
      --push \
      "''${tag_flags[@]}" \
      "''${build_arg_flags[@]}" \
      "''${platform_flags[@]}" \
      --provenance=mode=max --sbom=true \
      --metadata-file "$metadata_file" \
      -f "$file" \
      "$context"

    digest=$(jq -r '."containerimage.digest"' "$metadata_file")

    # Best effort, and null when it is not there — mirrors spindrift-build.yml's
    # "Report what was built" base-digest extraction exactly.
    base="$(docker buildx imagetools inspect "''${destination}@''${digest}" --format '{{ json .Provenance }}' 2>/dev/null \
      | jq -r '[.. | .uri? // empty | select(startswith("pkg:docker"))][0] // empty' \
      | grep -oE 'sha256(:|%3A)[0-9a-f]{64}' \
      | sed 's/%3A/:/' || true)"

    refs=$(jq -c --arg digest "$digest" '[.spec.destinations[] | . + "@" + $digest]' "$req")

    skiff_id=""
    hull_digest=""
    for tok in $(cat /proc/cmdline); do
      case "$tok" in
        bosun.skiff=*) skiff_id="''${tok#bosun.skiff=}" ;;
        bosun.hull=*) hull_digest="''${tok#bosun.hull=}" ;;
      esac
    done

    report="$(jq -nc \
      --arg bundleDigest "$bundle_digest" \
      --arg digest "$digest" \
      --arg destination "$destination" \
      --arg ref "''${destination}@''${digest}" \
      --argjson refs "$refs" \
      --arg base "$base" \
      --arg invocationId "$skiff_id" \
      --arg hullDigest "$hull_digest" \
      '{bundleDigest: $bundleDigest,
        digest: $digest,
        refs: $refs,
        baseDigest: (if $base == "" then null else $base end),
        buildkitProvenanceRef: $ref,
        sbomRef: $ref,
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          subject: [{
            name: $destination,
            digest: {sha256: ($digest | ltrimstr("sha256:"))}
          }],
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {
            buildDefinition: {
              buildType: "https://bosun.lolwtf.ca/buildtypes/skiff/v1",
              externalParameters: {
                bundleDigest: $bundleDigest
              },
              internalParameters: {
                hullDigest: $hullDigest
              }
            },
            runDetails: {
              builder: {id: "https://bosun.lolwtf.ca/skiff"},
              metadata: {invocationId: $invocationId}
            }
          }
        }}')"

    echo "skiff-mark build-done $(cut -d' ' -f1 /proc/uptime)"
    write_status SUCCEEDED
    echo "spindrift-result $(printf '%s' "$report" | base64 | tr -d '\n')"
  '';

  # The one job this skiff was booted for, whichever job that is.
  run = if isBuild then buildRun else runnerRun;

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

        ${lib.optionalString isBuild ''
          # The build variant's one rootfs addition: buildx as a CLI plugin,
          # in the path the docker CLI's plugin discovery looks in.
          mkdir -p root/usr/local/lib/docker/cli-plugins
          install -m755 ${buildxPlugin} root/usr/local/lib/docker/cli-plugins/docker-buildx
        ''}

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

        # Stock Runner.Worker overwrites ACTIONS_RESULTS_URL with the value
        # from GitHub's job message, which would clobber the host-provided
        # cache endpoint. The documented fix (gha-cache-server.falcondev.io):
        # rewrite the UTF-16LE string to a dead name, so the worker's
        # overwrite lands on ACTIONS_RESULTS_ORL and the environment's URL
        # survives. Same length, so no .NET metadata shifts. Skiffs never
        # self-update -- the runner lives in this immutable squashfs -- so
        # the patch cannot be reverted at runtime.
        sed -i 's/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x52\x00\x45\x00\x53\x00\x55\x00\x4C\x00\x54\x00\x53\x00\x5F\x00\x55\x00\x52\x00\x4C\x00/\x41\x00\x43\x00\x54\x00\x49\x00\x4F\x00\x4E\x00\x53\x00\x5F\x00\x52\x00\x45\x00\x53\x00\x55\x00\x4C\x00\x54\x00\x53\x00\x5F\x00\x4F\x00\x52\x00\x4C\x00/g' \
          root/home/runner/bin/Runner.Worker.dll
        # A silent no-op patch would mean cache traffic quietly going to
        # GitHub; fail the build instead. (`.` matches the UTF-16 NULs.)
        LC_ALL=C grep -qa 'A.C.T.I.O.N.S._.R.E.S.U.L.T.S._.O.R.L' root/home/runner/bin/Runner.Worker.dll

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
