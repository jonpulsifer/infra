#!/usr/bin/env bash
# A local, isolated Tinkerbell for failure-scenario tests of folly's provisioning path: the real
# v0.25.0 embedded binary (kube-apiserver, etcd, Smee, Tink server and controller, Rufio), dnsmasq
# for DHCP, DNS and TFTP, a registry, an HTTP server for the HookOS UKI, and QEMU machines behind
# Redfish BMCs, all in a user and network namespace of their own: nothing in it has a route to the
# lab or the internet. README.md says how to use it and what differs from the lab.
#
#   up | down | reset | status          start (fetching and checking the pins), stop, wipe the state
#                                       but the downloads, or print the processes and machines
#   kubectl ARGS... | sh                kubectl against the local API, or a shell in the namespace
#   selftest [NAME]                     provision a machine end to end and print the times
#   vm create NAME [--disk NAME:SIZE[:BUS[:SERIAL]]]... [--install-disk DEV] [--install-disk-serial S]
#             [--attest VERDICT] [--drive-opts OPTS] [--mem MIB]   OPTS go on every disk's QEMU -drive,
#                                       such as discard=unmap so a discard reaches the image; MIB is
#                                       the machine's memory (default TINK_LAB_VM_MEM)
#   vm delete NAME | vm console NAME TIMEOUT CMD... | vm screen NAME FILE.png
#   provision NAME [--action A] [--set KEY=VALUE]... [--unset KEY]... [--again] [--template NAME]
#             [--no-boot]
#   template NAME [--from FILE] [--os ubuntu] [--timeout ACTION=SECONDS]... [--global SECONDS]
#                                       a copy of the provision Template, or of FILE, with other
#                                       timeouts, or turned into the Ubuntu Template (ubuntu-template.py)
#   slow-installer SECONDS              the class's installer, writing ticks to its disk first
#   reconcile NAME [--interval S] [--rv RV] [--list FILE] | wait NAME TIMEOUT [STATE]
#   power NAME on|off|soft|cycle|status
#   cut NAME [--when COND] [--delay S] [--on-after S]
#   agent-net NAME cut|restore [--when COND] [--reject]
#   kill PROC [--signal SIG] [--when COND] | stop PROC | start PROC
#   disk NAME sentinel|shuffle|usb-attach DISK SIZE|detach DISK|attach DISK|data DISK [STEP]|scan DISK
#   tools-image TAG [--apk PKG]... [--overlay DIR]   the Template's tools image with Alpine packages
#                                       and DIR's files added, as ghcr.io/tink-lab/tools:TAG
#   ubuntu-installer                    scripts/tink-vm/ubuntu-installer's image, built without Docker,
#                                       as ghcr.io/tink-lab/ubuntu-installer:latest
#   efi NAME show|next ENTRY|order ENTRY,...|entry N DESC PARTUUID FILE|delete N|fill [FREE]|unfill
#   registry ls|delete IMAGE|restore IMAGE|deny [--drop]|throttle KBPS|allow [--when COND] [--delay S]
#   observe NAME [--no-console]
#   hookos-docker NAME ARGS...          hook-docker's docker on the machine's HookOS, such as
#                                       restart tink-worker
#   fleetd start NAME... [--template T] [--interval DUR] [--status S] [--installer IMAGE] | stop
#                                       fleetd's reconcile loop against a stand-in NetBox whose
#                                       devices are the machines named
#   fleetd hold REGEX | release         keep fleetd's matching NetBox requests unsent, or let them go
#   fleetd run                          start the fleetd process alone again, after a kill
#   netbox NAME[,NAME...] set KEY=VALUE|status=S... [--webhooks N] | NAME show | writes
#             | fail-patch on|off   one edit sets every named device in one write
#   webhook [N]                         N signed NetBox webhooks to fleetd at once
#   config NAME put [--file F] [--meta-code] | fetch
#                                       put a config for the machine in fleetd's Installer, or fetch
#                                       it as the installed node does
#   config-net NAME cut [--after BYTES] | restore [--when COND] [--delay S]
#                                       drop fleetd's config answers to the machine past BYTES
#   talos-boot NAME http | reset        the installed Talos fetches its config from fleetd's boot
#                                       listener over HTTP, or as installed (the machine is off)
#   bmc NAME fail-power on|off          the machine's BMC refuses (500) or performs power actions
#
# COND is action=NAME:STATE (an action of the machine's latest Workflow; RUNNING, SUCCESS, ...),
# workflow=STATE (or FINISHED), console=TEXT (serial output after the hook started),
# log=PROC:TEXT (a new line in logs/PROC.log) or, for a hook, disk=DISK:STAGE (the machine's disk
# gains a GPT, a formatted EFI partition or Talos's META; STAGE is gpt, esp or meta). Hooks print
# one JSON object per event and append it to events.jsonl in the state directory.
#
# Needs nix (for TOOLS), jq, yq, python3, curl and gh, KVM, and unprivileged user namespaces.
# State lives in TINK_LAB_DIR (default ~/.cache/tink-lab).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
dir=${TINK_LAB_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tink-lab}
run=${XDG_RUNTIME_DIR:-/tmp}/tink-lab-$(basename "$dir")
mkdir -p "$dir" "$run"

TOOLS=(qemu_kvm OVMFFull.fd swtpm python3Packages.virt-firmware socat dnsmasq nftables kubectl
  skopeo crane distribution openssl iproute2 util-linux mtools)

# The binary is the amd64 build of the release nix/services/tinkerbell.nix runs on spore; the
# SHA-256 is its line in the release's checksums-embedded.txt.
TINK_VERSION=v0.25.0
TINK_SHA256=0b1c033fc1dea85bfde973ebc63b5606c71ac8354306f4ec124e5d983a218089
# The talos-folly release whose signed HookOS UKI the machines netboot; GitHub's asset digest
# checks the download.
HOOKOS_RELEASE=${HOOKOS_RELEASE:-talos-folly/v1.14.5-41062277754}
# Seconds the supervisor waits before it restarts a Tinkerbell process that failed, as spore's
# unit's RestartSec does.
RESTART_SEC=${TINK_LAB_RESTART_SEC:-15}
VM_MEM=${TINK_LAB_VM_MEM:-3072}
VM_CPUS=${TINK_LAB_VM_CPUS:-2}

# The namespace's own network, a documentation range no lab network uses. The boot server stands
# in for spore's bootstrap address, and ghcr.io resolves to the registry.
NET=192.0.2
BOOT=$NET.1
REG=$NET.2
BRIDGE=tl0
# Smee's proxy DHCP listens on spore's bootstrap VLAN, which no node's port carries: folly's nodes
# take their boot option from UniFi on the Kubernetes network. An empty interface stands in, so
# the machines never hear Smee's offers, whose ACKs OVMF takes as a changed lease and declines.
SMEE_IF=tlboot
NS=tinkerbell
SITE=lab
UKI="hookos-amd64-secureboot-uki.efi"
COMPONENTS=(etcd apiserver tink-server tink-controller smee rufio)

say() { printf '%s %s\n' "$(date -u +%T)" "$*" >&2; }
die() {
  say "$*"
  exit 1
}

# event prints one JSON object of its key=value arguments and a time, and appends it to
# events.jsonl. A value that parses as JSON stays JSON.
event() {
  local line
  line=$(jq -cn --arg time "$(date -u +%FT%T.%3NZ)" '$ARGS.positional as $p
    | reduce range(0; $p | length) as $i ({time: $time};
        ($p[$i] | index("=")) as $e | . + {($p[$i][:$e]): ($p[$i][$e + 1:] | (. as $s | try fromjson catch $s))})' \
    --args "$@")
  printf '%s\n' "$line" | tee -a "$dir/events.jsonl"
}

tools() {
  local list paths p
  list=$(printf '%s\n' "${TOOLS[@]}" | sha256sum | cut -c1-16)
  if [ ! -f "$dir/tools.path" ] || [ "$(head -n 1 "$dir/tools.path")" != "$list" ]; then
    say "building the tools with nix"
    paths=$(printf 'nixpkgs#%s\n' "${TOOLS[@]}" | xargs nix build --no-link --print-out-paths)
    {
      echo "$list"
      for p in $paths; do
        if [ -d "$p/bin" ]; then echo "bin $p/bin"; fi
        if [ -d "$p/FV" ]; then echo "ovmf $p/FV"; fi
      done
    } >"$dir/tools.path"
  fi
  PATH=$(awk '$1 == "bin" { printf "%s:", $2 }' "$dir/tools.path")$PATH
  OVMF=${OVMF:-$(awk '$1 == "ovmf" { print $2 }' "$dir/tools.path")}
  export PATH OVMF
}

# fetch downloads each pin into downloads/, which nothing runs from, and copies out what passes its
# check. The Tinkerbell binary is the only download this host executes.
fetch() {
  local dl=$dir/downloads want
  mkdir -p "$dl/tinkerbell" "$dl/hookos" "$dir/bin" "$dir/srv/talos/$SITE"
  if ! echo "$TINK_SHA256  $dir/bin/tinkerbell" | sha256sum -c --status 2>/dev/null; then
    say "downloading Tinkerbell $TINK_VERSION"
    gh release download "$TINK_VERSION" -R tinkerbell/tinkerbell -D "$dl/tinkerbell" --clobber \
      -p tinkerbell-embedded-linux-amd64 -p checksums-embedded.txt
    grep -qx "$TINK_SHA256  tinkerbell-embedded-linux-amd64" "$dl/tinkerbell/checksums-embedded.txt" \
      || die "the release's checksums-embedded.txt does not list the pinned SHA-256"
    install -m 0755 "$dl/tinkerbell/tinkerbell-embedded-linux-amd64" "$dir/bin/tinkerbell.new"
    echo "$TINK_SHA256  $dir/bin/tinkerbell.new" | sha256sum -c --status \
      || die "tinkerbell-embedded-linux-amd64 does not match the pinned SHA-256"
    mv "$dir/bin/tinkerbell.new" "$dir/bin/tinkerbell"
  fi
  want=$(gh release view "$HOOKOS_RELEASE" -R jonpulsifer/infra --json assets \
    -q ".assets[] | select(.name == \"$UKI\") | .digest" | sed 's/^sha256://')
  [ -n "$want" ] || die "$HOOKOS_RELEASE has no $UKI"
  if ! echo "$want  $dir/srv/talos/$SITE/$UKI" | sha256sum -c --status 2>/dev/null; then
    say "downloading HookOS from $HOOKOS_RELEASE"
    gh release download "$HOOKOS_RELEASE" -R jonpulsifer/infra -p "$UKI" -D "$dl/hookos" --clobber
    echo "$want  $dl/hookos/$UKI" | sha256sum -c --status || die "$UKI does not match its release digest"
    install -m 0644 "$dl/hookos/$UKI" "$dir/srv/talos/$SITE/$UKI"
  fi
}

# pki mints the API's CA, serving and admin certificates and its service-account key, as
# scripts/tinkerbell-certs.sh does for spore but with local names, and the BMCs' certificate.
pki() {
  local p=$dir/pki
  [ -f "$p/kubeconfig" ] && return
  mkdir -p "$p"
  (
    cd "$p"
    umask 077
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key
    openssl req -x509 -new -key ca.key -subj "/CN=tink-lab CA" -days 365 \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt
    sign() {
      openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1.key"
      openssl req -new -key "$1.key" -subj "$2" -out "$1.csr"
      printf '%s\n' "$3" >"$1.ext"
      openssl x509 -req -in "$1.csr" -CA ca.crt -CAkey ca.key -days 365 \
        -set_serial "0x$(openssl rand -hex 16)" -extfile "$1.ext" -out "$1.crt" 2>/dev/null
    }
    sign server "/CN=kube-apiserver" "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:kubernetes,DNS:kubernetes.default,DNS:kubernetes.default.svc,IP:127.0.0.1"
    sign admin "/O=system:masters/CN=tinkerbell-admin" "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth"
    sign bmc "/CN=tink-lab BMC" "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1"
    # With a P-256 service-account key, the embedded apiserver never finishes its TLS handshakes.
    openssl genpkey -quiet -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out service-account.key
    jq -n --arg d "$p" '{apiVersion: "v1", kind: "Config",
      clusters: [{name: "tink-lab", cluster: {server: "https://127.0.0.1:6443", "certificate-authority": "\($d)/ca.crt"}}],
      users: [{name: "admin", user: {"client-certificate": "\($d)/admin.crt", "client-key": "\($d)/admin.key"}}],
      contexts: [{name: "tink-lab", context: {cluster: "tink-lab", user: "admin", namespace: "tinkerbell"}}],
      "current-context": "tink-lab"}' >kubeconfig
  )
}

nspid() { cat "$dir/ns.pid" 2>/dev/null || true; }
nsup() { [ -n "$(nspid)" ] && kill -0 "$(nspid)" 2>/dev/null; }
# inns runs a command as root of the namespace's user namespace, inside its network namespace.
inns() {
  nsup || die "the environment is not up; run tink-lab.sh up"
  nsenter -t "$(nspid)" -U -n --preserve-credentials -- "$@"
}
KUBE() { inns kubectl --kubeconfig "$dir/pki/kubeconfig" "$@"; }

pidof_() { cat "$dir/pids/$1" 2>/dev/null || true; }
alive() {
  local pid
  pid=$(pidof_ "$1")
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
# daemon starts NAME in the namespace, detached, with its log in logs/NAME.log and its PID in
# pids/NAME.
daemon() {
  local name=$1
  shift
  mkdir -p "$dir/logs" "$dir/pids"
  alive "$name" && return
  nsenter -t "$(nspid)" -U -n --preserve-credentials -- setsid "$@" >>"$dir/logs/$name.log" 2>&1 </dev/null &
  echo $! >"$dir/pids/$name"
}

netns() {
  if ! nsup; then
    unshare -Urn sleep infinity </dev/null >/dev/null 2>&1 &
    echo $! >"$dir/ns.pid"
    sleep 0.2
  fi
  inns sh -c "
    ip link set lo up
    ip link show $BRIDGE >/dev/null 2>&1 || ip link add $BRIDGE type bridge
    ip addr replace $BOOT/24 dev $BRIDGE
    ip addr replace $REG/24 dev $BRIDGE
    ip link set $BRIDGE up
    ip link show $SMEE_IF >/dev/null 2>&1 || ip link add $SMEE_IF type dummy
    ip link set $SMEE_IF up"
}

# tink_flags prints spore's flags (nix/services/tinkerbell.nix) with the namespace's addresses and
# local files. The apiserver needs --advertise-address because the namespace has no default
# route, and it listens on loopback, which stands in for spore's firewall.
tink_flags() {
  local s=$dir/state
  printf '%s\n' \
    "--backend-kube-config=$dir/pki/kubeconfig" \
    "--etcd-dir=$s/etcd" \
    "--etcd-servers=http://localhost:2379" \
    "--kube-apiserver-bind-address=127.0.0.1" \
    "--secure-port=6443" \
    "--advertise-address=$BOOT" \
    "--kube-apiserver-tls-cert-file=$dir/pki/server.crt" \
    "--kube-apiserver-tls-private-key-file=$dir/pki/server.key" \
    "--client-ca-file=$dir/pki/ca.crt" \
    "--service-account-key-file=$dir/pki/service-account.key" \
    "--service-account-signing-key-file=$dir/pki/service-account.key" \
    "--service-account-issuer=https://kubernetes.default.svc" \
    "--anonymous-auth=false" \
    "--authorization-mode=RBAC" \
    "--enable-ui=false" \
    "--enable-tootles=false" \
    "--enable-secondstar=false" \
    "--public-ipv4=$BOOT" \
    "--bind-address=$BOOT" \
    "--http-port=7080" \
    "--tink-server-bind-addr=$BOOT" \
    "--tink-server-bind-port=42113" \
    "--syslog-enabled=true" \
    "--syslog-bind-addr=$BOOT" \
    "--syslog-bind-port=514" \
    "--dhcp-mode=proxy" \
    "--dhcp-bind-interface=$SMEE_IF" \
    "--tftp-server-enabled=false" \
    "--dhcp-tftp-ip=$BOOT" \
    "--ipxe-override-arch-mapping=7=talos/$SITE/ipxe-amd64.efi" \
    "--ipxe-http-binary-enabled=false" \
    "--ipxe-http-script-osie-url=http://$BOOT/talos/$SITE"
}

# component_flags prints the flags that leave one part of the embedded binary running, for
# TINK_LAB_SPLIT=1. Every process serves HTTP, so all but Smee, whose iPXE scripts the machines
# fetch from 7080, take a port of their own; they come after tink_flags and win.
component_flags() {
  local on=$1 c flag port=7080 i=0
  for c in "${COMPONENTS[@]}"; do
    case $c in
      tink-server | tink-controller | smee) flag=--enable-$c ;;
      rufio) flag=--enable-rufio-controller ;;
      *) flag="" ;;
    esac
    if [ -n "$flag" ]; then
      if [ "$c" = "$on" ]; then echo "$flag=true"; else echo "$flag=false"; fi
    fi
    i=$((i + 1))
    if [ "$c" = "$on" ] && [ "$c" != smee ]; then port=$((7080 + i)); fi
  done
  echo "--http-port=$port"
  case $on in
    etcd) printf '%s\n' --enable-embedded-etcd=true --enable-embedded-kube-apiserver=false --enable-crd-migrations=false ;;
    apiserver) printf '%s\n' --enable-embedded-etcd=false --enable-embedded-kube-apiserver=true --enable-crd-migrations=false ;;
    # The binary creates the CRDs only in a process that runs a service, so the Tink controller,
    # which needs them first, makes them.
    tink-controller) printf '%s\n' --enable-embedded-etcd=false --enable-embedded-kube-apiserver=false --enable-crd-migrations=true ;;
    *) printf '%s\n' --enable-embedded-etcd=false --enable-embedded-kube-apiserver=false --enable-crd-migrations=false ;;
  esac
}

split() { [ "${TINK_LAB_SPLIT:-$(cat "$dir/split" 2>/dev/null || echo 0)}" = 1 ]; }

# start_tink starts the binary, or with split one process per part, under the supervisor, which
# restarts a process that failed after RESTART_SEC as systemd's Restart=on-failure does.
start_tink() {
  local c flags extra
  mkdir -p "$dir/state"
  mapfile -t flags < <(tink_flags)
  if split; then
    echo 1 >"$dir/split"
    for c in "${COMPONENTS[@]}"; do
      if [ -n "${1:-}" ] && [ "$1" != "$c" ]; then continue; fi
      mapfile -t extra < <(component_flags "$c")
      daemon "$c" "$0" _supervise "$c" "$dir/bin/tinkerbell" "${flags[@]}" "${extra[@]}"
      if [ "$c" = etcd ]; then sleep 2; fi
    done
  else
    echo 0 >"$dir/split"
    daemon tinkerbell "$0" _supervise tinkerbell "$dir/bin/tinkerbell" "${flags[@]}"
  fi
}

supervise() {
  local name=$1 status
  shift
  trap 'kill "$(cat "$dir/pids/$name.child" 2>/dev/null)" 2>/dev/null; rm -f "$dir/pids/$name.child"; exit 0' TERM INT
  cd "$dir/state"
  export HOME=$dir/state
  while :; do
    "$@" &
    echo $! >"$dir/pids/$name.child"
    status=0
    wait $! || status=$?
    rm -f "$dir/pids/$name.child"
    # A clean exit, or SIGHUP, SIGINT, SIGTERM or SIGPIPE, is not a failure to systemd.
    case $status in
      0 | 129 | 130 | 141 | 143)
        echo "supervisor: $name exited $status; not restarting"
        exit 0
        ;;
    esac
    echo "supervisor: $name exited $status; restarting in ${RESTART_SEC}s"
    sleep "$RESTART_SEC"
  done
}

api_ready() {
  local end=$((SECONDS + ${1:-120}))
  until KUBE get --raw /readyz >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$end" ] || die "the API is not ready after ${1:-120}s; see $dir/logs"
    sleep 2
  done
}

start_dnsmasq() {
  mkdir -p "$dir/tftp/talos/$SITE" "$dir/dhcp-hosts" "$dir/state"
  cat >"$dir/dnsmasq.conf" <<EOF
# UniFi's part on folly's Kubernetes network, where the nodes sit: leases, DNS and the boot option
# that names the netboot iPXE on the boot server (terraform/network/unifi/folly/bootstrap.tf), and
# spore's part: TFTP of that iPXE. DNS answers only ghcr.io, with the registry; every other name
# fails.
interface=$BRIDGE
dhcp-boot=talos/$SITE/ipxe-amd64.efi,,$BOOT
bind-dynamic
no-resolv
no-hosts
log-queries
log-dhcp
domain-needed
address=/ghcr.io/$REG
dhcp-range=$NET.100,$NET.199,255.255.255.0,1h
dhcp-option=option:router,$BOOT
dhcp-option=option:ntp-server,$BOOT
dhcp-hostsdir=$dir/dhcp-hosts
dhcp-leasefile=$dir/state/dnsmasq.leases
enable-tftp
tftp-root=$dir/tftp
user=root
group=
pid-file=
EOF
  daemon dnsmasq dnsmasq --keep-in-foreground --log-facility=- --conf-file="$dir/dnsmasq.conf"
}

start_registry() {
  mkdir -p "$dir/registry"
  cat >"$dir/registry.yml" <<EOF
version: 0.1
log:
  level: info
storage:
  filesystem:
    rootdirectory: $dir/registry
  delete:
    enabled: true
http:
  addr: $REG:80
EOF
  # distribution exports traces by default; there is nothing to take them.
  OTEL_TRACES_EXPORTER=none daemon registry registry serve "$dir/registry.yml"
}

# http is nginx's part on spore: the HookOS UKI. ntp is chrony's.
start_http() {
  daemon http python3 -I -m http.server --bind "$BOOT" --directory "$dir/srv" 80
}
start_ntp() {
  daemon ntp python3 -I "$here/ntp.py" "$BOOT"
}

# images prints the lab images the machines pull: the Template's actions, the agent the HookOS
# command line pins, and each class's Talos installer.
images() {
  {
    yq -r '.spec.data' "$repo/clusters/folly/tinkerbell/template.yaml" | grep -o 'ghcr\.io/[^ "]*'
    jq -r .tink_agent_image "$repo/clusters/folly/talos/netboot.json"
    jq -r '.. | .installer_image? // empty' "$repo/clusters/folly/fleet/class-inputs.json"
  } | sort -u
}

# cache_name names a reference's OCI layout under images/.
cache_name() { echo "$1" | sed 's|^ghcr\.io/||; s|[/:@]|_|g'; }
# push_ref is where a cached image goes in the registry: its repository, tagged with its tag or,
# for a digest, sha256-<hex>. A pull by digest finds it either way.
push_ref() {
  local r=${1#ghcr.io/} tag
  case $r in
    *@sha256:*)
      tag=sha256-${r#*@sha256:}
      r=${r%@*}
      ;;
    *:*)
      tag=${r##*:}
      r=${r%:*}
      ;;
  esac
  echo "$REG/$r:$tag"
}

# skopeo wants a trust policy. A reference by digest checks its content; the installer's is a tag,
# as class-inputs.json names it.
skopeo_() {
  [ -f "$dir/policy.json" ] || echo '{"default": [{"type": "insecureAcceptAnything"}]}' >"$dir/policy.json"
  "$@" --policy "$dir/policy.json"
}
load_images() {
  local ref c
  mkdir -p "$dir/images"
  while read -r ref; do
    c=$dir/images/$(cache_name "$ref")
    if [ ! -f "$c/index.json" ]; then
      say "caching $ref"
      skopeo_ skopeo copy -q --all --preserve-digests "docker://$ref" "oci:$c"
    fi
    if ! inns skopeo inspect --tls-verify=false --raw "docker://$(push_ref "$ref")" >/dev/null 2>&1; then
      say "loading $ref into the registry"
      skopeo_ inns skopeo copy -q --all --preserve-digests --dest-tls-verify=false "oci:$c" "docker://$(push_ref "$ref")"
    fi
  done < <(images)
}

# agent builds tink-lab's agent, the lab's tink-agent-autoid with agent/entry.sh in front of its
# own, and prints its digest.
agent() {
  local base layer
  base=$(push_ref "$(jq -r .tink_agent_image "$repo/clusters/folly/talos/netboot.json")")
  layer=$dir/agent-layer.tar
  rm -rf "$dir/build/agent" && mkdir -p "$dir/build/agent/tinklab/seed/var/lib/cloud/seed/nocloud"
  install -m 0755 "$here/agent/entry.sh" "$dir/build/agent/tinklab/entry.sh"
  install -m 0600 "$here/agent/user-data" "$dir/build/agent/tinklab/seed/var/lib/cloud/seed/nocloud/user-data"
  tar --owner=0 --group=0 --mtime=@0 -C "$dir/build/agent/tinklab/seed" -czf "$dir/build/agent/tinklab/payload.tar.gz" var
  rm -rf "$dir/build/agent/tinklab/seed"
  tar --owner=0 --group=0 --mtime=@0 -C "$dir/build/agent" -cf "$layer" tinklab
  {
    inns crane append --insecure --platform linux/amd64 -b "$base" -f "$layer" -t "$REG/tink-lab/agent:layer"
    inns crane mutate --insecure "$REG/tink-lab/agent:layer" -t "$REG/tink-lab/agent:latest" \
      --entrypoint /autoid/busybox,sh,/tinklab/entry.sh
  } >>"$dir/logs/agent.log" 2>&1 || die "the agent build failed; see $dir/logs/agent.log"
  inns crane digest --insecure "$REG/tink-lab/agent:latest"
}

# cmdline prints the HookOS command line tink-lab passes: nix/images/hookos-folly.nix's, with the
# boot server for spore, tink-lab's agent, no attestation URL, and the registry allowed over HTTP.
cmdline() {
  local digest=$1 verdict=${2:-pass}
  echo "facility= syslog_host=$BOOT grpc_authority=$BOOT:42113 tinkerbell_tls=false" \
    "tinkerbell_insecure_tls=false modules=loop,squashfs,sd-mod,usb-storage intel_iommu=on iommu=pt" \
    "console=ttyS0,115200 console=tty0 talos.platform=metal" \
    "tink_worker_image=ghcr.io/tink-lab/agent@$digest fleet_attest_url= fleet_ntp_server=$BOOT" \
    "insecure_registries=ghcr.io tinklab_attest=$verdict"
}

build_ipxe() {
  local out
  out=$(nix build --no-link --print-out-paths --impure --expr "
    (builtins.getFlake \"nixpkgs\").legacyPackages.x86_64-linux.callPackage $here/ipxe.nix {
      boot = \"$BOOT\"; site = \"$SITE\"; cmdline = \"$(cmdline "$1")\"; }")
  install -m 0644 "$out/ipxe.efi" "$dir/tftp/talos/$SITE/ipxe-amd64.efi"
}

apply_base() {
  local c end=$((SECONDS + 120))
  # The binary creates its CRDs after the API answers.
  for c in hardware templates workflows machines.bmc jobs.bmc; do
    until KUBE wait --for condition=established "crd/$c.tinkerbell.org" --timeout=5s >/dev/null 2>&1; do
      [ "$SECONDS" -lt "$end" ] || die "no CRD $c.tinkerbell.org after 120s"
      sleep 2
    done
  done
  KUBE create namespace "$NS" --dry-run=client -o yaml | KUBE apply -f - >/dev/null
  KUBE apply -n "$NS" -f "$repo/clusters/folly/tinkerbell/template.yaml" >/dev/null
  KUBE -n "$NS" create secret generic bmc-redfish --from-literal=username=tink-lab \
    --from-literal=password=tink-lab --dry-run=client -o yaml | KUBE apply -f - >/dev/null
}

up() {
  local digest v
  tools
  fetch
  pki
  netns
  start_dnsmasq
  start_registry
  start_http
  start_ntp
  if split; then
    # The other parts exit when the API or its CRDs are missing, and the supervisor restarts
    # them; the Tink controller creates the CRDs.
    start_tink etcd
    start_tink apiserver
  fi
  start_tink
  api_ready 180
  apply_base
  load_images
  digest=$(agent)
  echo "$digest" >"$dir/agent.digest"
  build_ipxe "$digest"
  for v in "$dir"/vms/*/vm.json; do
    if [ -f "$v" ]; then start_bmc "$(jq -r .name "$v")"; fi
  done
  event event=up agent="$digest" split="$(split && echo true || echo false)"
}

# selftest is the Phase 0 proof on one machine: a provision Workflow through Rufio, Smee, the Tink
# server and tink-agent to a terminal state, then the installed Talos booting from its disk and
# asking DNS for its config host, which the namespace cannot resolve. It prints the times.
selftest() {
  local name=${1:-selftest} t0 host ip hookos=null done_=null talos=null rc=0 wf
  [ -f "$(vmdir "$name")/vm.json" ] || vm_create "$name" >/dev/null
  ip=$(vmjson "$name" .ip)
  host=$(yq -r .env.CONFIG_URL "$repo/.github/workflows/talos-images.yml" | sed -E 's|^https://([^/]+)/.*|\1|')
  local q0
  q0=$(wc -l <"$dir/logs/dnsmasq.log")
  t0=$SECONDS
  provision "$name" >/dev/null
  wait_cond "$name" "console=(ns: getty) HookOS" 300 && hookos=$((SECONDS - t0))
  wait_cond "$name" workflow=FINISHED 1800 && done_=$((SECONDS - t0))
  wf=$(latest "$name" | jq -c '{name: .metadata.name, state: .status.state,
    actions: [.status.tasks[]?.actions[]? | {name, state, executionDuration}]}')
  reconcile "$name" >/dev/null
  if [ "$(jq -r .state <<<"$wf")" = SUCCESS ]; then
    local end=$((SECONDS + 300))
    until tail -n +"$((q0 + 1))" "$dir/logs/dnsmasq.log" | grep -qF "query[A] $host from $ip"; do
      [ "$SECONDS" -lt "$end" ] || break
      sleep 1
    done
    tail -n +"$((q0 + 1))" "$dir/logs/dnsmasq.log" | grep -qF "query[A] $host from $ip" && talos=$((SECONDS - t0))
  fi
  [ "$talos" != null ] || rc=1
  event event=selftest vm="$name" "workflow=$wf" hookos_shell_s="$hookos" workflow_finished_s="$done_" \
    talos_config_fetch_s="$talos" config_host="$host" status="$rc"
  return "$rc"
}

down() {
  local f
  for f in "$dir"/pids/*; do
    [ -f "$f" ] || continue
    case $f in *.child) continue ;; esac
    kill "$(cat "$f")" 2>/dev/null || true
  done
  sleep 1
  for f in "$dir"/pids/* "$dir"/vms/*/qemu.pid; do
    [ -f "$f" ] || continue
    kill -9 "$(cat "$f")" 2>/dev/null || true
    case $f in "$dir"/pids/*) rm -f "$f" ;; esac
  done
  pkill -f "swtpm socket.*$run/" 2>/dev/null || true
  if nsup; then kill "$(nspid)"; fi
  rm -f "$dir/ns.pid"
  event event=down >/dev/null
}

# ---- machines ----

vmdir() { echo "$dir/vms/$1"; }
vmjson() { jq -r "$2" "$(vmdir "$1")/vm.json"; }
need_vm() { [ -f "$(vmdir "$1")/vm.json" ] || die "no machine $1"; }

# The sentinels are records at fixed offsets of each disk image, behind a GPT whose one partition
# is named for the disk, so a wipe or an install that touches a disk shows.
sentinel_offsets() {
  local size=$1
  echo "$((1 << 20)) $((17 << 20)) $((size / 2)) $((size - (2 << 20)))"
}
write_sentinels() {
  local file=$1 label=$2 size off
  size=$(stat -c %s "$file")
  printf 'label: gpt\nstart=2048, size=65536, name="sentinel-%s"\n' "$label" | sfdisk -q "$file" >/dev/null
  for off in $(sentinel_offsets "$size"); do
    printf 'TINKLAB-SENTINEL disk=%s offset=%s\n' "$label" "$off" \
      | dd of="$file" bs=1 seek="$off" conv=notrunc status=none
  done
}
read_sentinels() {
  local file=$1 label=$2 size off got
  size=$(stat -c %s "$file")
  for off in $(sentinel_offsets "$size"); do
    got=$(dd if="$file" bs=1 skip="$off" count=80 status=none | tr -d '\0' | head -n 1)
    if [ "$got" = "TINKLAB-SENTINEL disk=$label offset=$off" ]; then
      echo "{\"offset\":$off,\"intact\":true}"
    else
      echo "{\"offset\":$off,\"intact\":false}"
    fi
  done | jq -sc .
}

vm_create() {
  local name=$1 idx d spec dname size bus serial install="" install_serial="" verdict=pass json='[]' n=0 disks=() opts="" mem=$VM_MEM
  shift
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,15}$ ]] || die "a machine's name is a short DNS label"
  [ -f "$(vmdir "$name")/vm.json" ] && die "machine $name exists"
  while [ $# -gt 0 ]; do
    case $1 in
      --disk) disks+=("$2") && shift 2 ;;
      --install-disk) install=$2 && shift 2 ;;
      --install-disk-serial) install_serial=$2 && shift 2 ;;
      --attest) verdict=$2 && shift 2 ;;
      --drive-opts) opts=$2 && shift 2 ;;
      --mem) mem=$2 && shift 2 ;;
      *) die "vm create: unknown $1" ;;
    esac
  done
  [ ${#disks[@]} -gt 0 ] || disks=(disk0:8G)
  [[ $opts =~ ^[a-z0-9_.=,-]*$ ]] || die "--drive-opts takes QEMU drive options, such as discard=unmap"
  [[ $mem =~ ^[0-9]+$ ]] || die "--mem takes MiB"
  idx=1
  while grep -qs "\"index\": $idx," "$dir"/vms/*/vm.json; do idx=$((idx + 1)); done
  d=$(vmdir "$name")
  mkdir -p "$d/tpm"
  install -m 0644 "$OVMF/OVMF_VARS.fd" "$d/vars.fd"
  for spec in "${disks[@]}"; do
    IFS=: read -r dname size bus serial <<<"$spec"
    bus=${bus:-virtio}
    serial=${serial:-tl$idx$dname}
    case $bus in virtio | nvme | sata | usb) ;; *) die "bus $bus is not virtio, nvme, sata or usb" ;; esac
    truncate -s "${size:-8G}" "$d/$dname.img"
    write_sentinels "$d/$dname.img" "$name-$dname"
    json=$(jq -c --arg n "$dname" --arg b "$bus" --arg s "$serial" --arg f "$d/$dname.img" \
      --argjson slot "$n" '. + [{name: $n, bus: $b, serial: $s, file: $f, slot: $slot}]' <<<"$json")
    n=$((n + 1))
  done
  [ -n "$install" ] || install=$(jq -r '.[0] | if .bus == "virtio" then "/dev/vda"
    elif .bus == "nvme" then "/dev/nvme0n1" else "/dev/sda" end' <<<"$json")
  [ -n "$install_serial" ] || install_serial=$(jq -r '.[0].serial' <<<"$json")
  jq -n --arg name "$name" --argjson index "$idx" --argjson disks "$json" --arg install "$install" \
    --arg install_serial "$install_serial" --arg verdict "$verdict" --arg net "$NET" --arg opts "$opts" --argjson mem "$mem" '{name: $name, index: $index, mem: $mem,
      mac: ("52:54:00:7e:00:" + ($index | tostring | if length == 1 then "0" + . else . end)),
      ip: ($net + "." + (100 + $index | tostring)), tap: ("tap" + ($index | tostring)),
      uuid: ("7e1ab000-0000-4000-8000-" + ($index | tostring | "000000000000"[length:] + .)),
      bmc_port: (9440 + $index), install_disk: $install,
      install_disk_serial: $install_serial, attest: $verdict, drive_opts: $opts, disks: $disks}' >"$d/vm.json"
  echo "$(vmjson "$name" .mac),$(vmjson "$name" .ip),$name" >"$dir/dhcp-hosts/$name"
  start_bmc "$name"
  apply_machine "$name"
  apply_hardware "$name" false
  event event=vm-create vm="$name" "machine=$(jq -c . "$d/vm.json")"
}

vm_delete() {
  local name=$1
  need_vm "$name"
  power_cut_now "$name" >/dev/null || true
  stop_proc "bmc-$name" || true
  pkill -f "swtpm socket.*$run/$name/" 2>/dev/null || true
  KUBE -n "$NS" delete workflow -l "lolwtf.ca/node=$name" --ignore-not-found >/dev/null
  KUBE -n "$NS" delete hardware,machine.bmc.tinkerbell.org "$name" --ignore-not-found >/dev/null
  inns ip link del "$(vmjson "$name" .tap)" 2>/dev/null || true
  rm -rf "$(vmdir "$name")" "${run:?}/$name" "$dir/dhcp-hosts/$name"
  # dnsmasq keeps a deleted hosts file's entry until a SIGHUP, and a new machine takes the freed
  # index's MAC, so it would get the old name.
  if alive dnsmasq; then kill -HUP "$(pidof_ dnsmasq)"; fi
  event event=vm-delete vm="$name"
}

# start_bmc plugs the machine's tap into the bridge and starts its BMC.
start_bmc() {
  local name=$1 d tap
  d=$(vmdir "$name")
  tap=$(vmjson "$name" .tap)
  mkdir -p "$run/$name"
  inns sh -c "ip link show $tap >/dev/null 2>&1 || ip tuntap add $tap mode tap; ip link set $tap master $BRIDGE up"
  TINK_LAB_QMP=$run/$name/qmp.sock daemon "bmc-$name" python3 -I "$here/bmc.py" "$name" \
    "$(vmjson "$name" .bmc_port)" "$dir/pki/bmc.crt" "$dir/pki/bmc.key" "$d"
}

labels() {
  jq -cn --arg n "$1" --arg a "${2:-}" '{"lolwtf.ca/managed-by": "fleet-controller", "lolwtf.ca/node": $n}
    + (if $a != "" then {"lolwtf.ca/action": $a} else {} end)'
}

# apply_hardware applies the machine's Hardware in fleetd's shape (Config.Hardware in
# apps/fleetd/fleet/objects.go), with tink-lab's HookOS URL and command line.
apply_hardware() {
  local name=$1 netboot=$2 script
  script=$(printf '#!ipxe\nimgfree\nchain --autofree http://%s/talos/%s/%s %s\n' "$BOOT" "$SITE" "$UKI" \
    "$(cmdline "$(cat "$dir/agent.digest")" "$(vmjson "$name" .attest)")")
  jq -n --arg name "$name" --arg ns "$NS" --argjson labels "$(labels "$name")" --arg mac "$(vmjson "$name" .mac)" \
    --arg disk "$(vmjson "$name" .install_disk)" --argjson netboot "$netboot" --arg script "$script" '{
      apiVersion: "tinkerbell.org/v1alpha1", kind: "Hardware",
      metadata: {name: $name, namespace: $ns, labels: $labels},
      spec: {disks: [{device: $disk}],
        interfaces: [{dhcp: {mac: $mac, hostname: $name, arch: "x86_64", uefi: true},
          netboot: {allowPXE: $netboot, allowWorkflow: $netboot, ipxe: {contents: $script}}}],
        bmcRef: {apiGroup: "bmc.tinkerbell.org", kind: "Machine", name: $name}}}' \
    | KUBE apply --server-side --field-manager=fleet-controller --force-conflicts -f - >/dev/null
}

# apply_machine applies the machine's Rufio Machine in fleetd's shape, with the Redfish provider
# against its BMC where the lab has AMT.
apply_machine() {
  local name=$1
  jq -n --arg name "$name" --arg ns "$NS" --argjson labels "$(labels "$name")" \
    --argjson port "$(vmjson "$name" .bmc_port)" '{
    apiVersion: "bmc.tinkerbell.org/v1alpha1", kind: "Machine",
    metadata: {name: $name, namespace: $ns, labels: $labels},
    spec: {connection: {host: "127.0.0.1", port: $port, insecureTLS: true,
      authSecretRef: {name: "bmc-redfish", namespace: $ns},
      providerOptions: {preferredOrder: ["gofish"], redfish: {port: $port}}}}}' \
    | KUBE apply --server-side --field-manager=fleet-controller --force-conflicts -f - >/dev/null
}

workflows() {
  KUBE -n "$NS" get workflows -l "lolwtf.ca/node=$1" -o json \
    | jq -c '.items | sort_by(.metadata.creationTimestamp) | reverse'
}
latest() { workflows "$1" | jq -c '.[0] // empty'; }
finished() {
  case ${1#STATE_} in
    SUCCESS | FAILED | TIMEOUT) return 0 ;;
    *) return 1 ;;
  esac
}

# provision does what fleetd's Reconciler.start does for one device
# (apps/fleetd/fleet/reconcile.go): finished Workflows are deleted, a running one is adopted, and
# otherwise the Hardware allows netboot before a new Workflow (Config.Workflow) exists. --again
# creates one even when one runs. --template runs a copy that template made. --no-boot leaves out
# the boot mode, as fleetd does for a device without a BMC or a machine that waits in HookOS, so
# Rufio does not power-cycle the machine and the agent of the boot it is in takes the run.
provision() {
  local name=$1 action=provision again=false sets=() unsets=() wf running="" w tmpl=provision boot=netboot
  shift
  need_vm "$name"
  while [ $# -gt 0 ]; do
    case $1 in
      --action) action=$2 && shift 2 ;;
      --set) sets+=("$2") && shift 2 ;;
      --unset) unsets+=("$2") && shift 2 ;;
      --again) again=true && shift ;;
      --template) tmpl=$2 && shift 2 ;;
      --no-boot) boot="" && shift ;;
      *) die "provision: unknown $1" ;;
    esac
  done
  while read -r w; do
    [ -n "$w" ] || continue
    if finished "$(jq -r '.status.state // ""' <<<"$w")"; then
      KUBE -n "$NS" delete workflow "$(jq -r .metadata.name <<<"$w")" >/dev/null
    elif [ -z "$running" ]; then
      running=$(jq -r .metadata.name <<<"$w")
    fi
  done < <(workflows "$name" | jq -c '.[]')
  if [ -n "$running" ] && [ "$again" = false ]; then
    event event=provision vm="$name" workflow="$running" adopted=true
    return
  fi
  local attest wipe retire install=false installer=""
  case $action in
    provision) attest=true wipe=true retire=false ;;
    attest) attest=true wipe=false retire=false ;;
    wipe) attest=false wipe=true retire=false ;;
    retire) attest=false wipe=true retire=true ;;
    *) die "action $action is not provision, attest, wipe or retire" ;;
  esac
  if [ "$action" = provision ]; then
    installer=$(jq -r '[.. | .installer_image? // empty][0]' "$repo/clusters/folly/fleet/class-inputs.json")
    install=true
  fi
  wf=$(jq -n --arg name "$action-$name-$(date +%s)" --arg ns "$NS" --argjson labels "$(labels "$name" "$action")" \
    --arg hw "$name" --arg attest "$attest" --arg wipe "$wipe" --arg retire "$retire" \
    --arg install "$install" --arg installer "$installer" \
    --arg serial "$(vmjson "$name" '.install_disk_serial // ""')" --arg tmpl "$tmpl" --arg boot "$boot" '{
      apiVersion: "tinkerbell.org/v1alpha1", kind: "Workflow",
      metadata: {name: $name, namespace: $ns, labels: $labels},
      spec: {templateRef: $tmpl, hardwareRef: $hw,
        hardwareMap: {attest: $attest, wipe: $wipe, retire: $retire, install: $install, installer_image: $installer,
          install_disk_serial: $serial},
        bootOptions: ({toggleAllowNetboot: false} + if $boot != "" then {bootMode: $boot} else {} end)}}')
  for w in "${sets[@]}"; do
    wf=$(jq -c --arg k "${w%%=*}" --arg v "${w#*=}" '.spec.hardwareMap[$k] = $v' <<<"$wf")
  done
  for w in "${unsets[@]}"; do
    wf=$(jq -c --arg k "$w" 'del(.spec.hardwareMap[$k])' <<<"$wf")
  done
  apply_hardware "$name" true
  KUBE create -f - <<<"$wf" >/dev/null
  event event=provision vm="$name" workflow="$(jq -r .metadata.name <<<"$wf")" template="$tmpl" boot_mode="$boot" \
    "hardwareMap=$(jq -c .spec.hardwareMap <<<"$wf")"
}

# reconcile is one fleetd pass for the machine (Reconciler.device in apps/fleetd/fleet/reconcile.go):
# nudgeOverdue, then the Hardware's netboot flags, on while a Workflow has not finished and off
# otherwise. Like fleetd, it lists the machine's Workflows once, and acts on that list.
#   - An unfinished Workflow with status.globalExecutionStop, more than INTERVAL past it, gets the
#     lolwtf.ca/overdue-at annotation (annotateOverdue).
#   - An unfinished, non-retire Workflow with none is deleted once creationTimestamp +
#     status.globalTimeout (1800 s when missing) is more than INTERVAL past (endWithoutDeadline).
#     The delete carries a resourceVersion precondition, so a write since the list answers 409 and
#     keeps the Workflow. The deleted Workflow no longer counts for netboot.
# --interval S is FLEET_INTERVAL (default 120, fleetd's 2m). --rv RV sends RV as the precondition
# instead of the listed resourceVersion, which stands in for a write between fleetd's list and its
# delete (the race); it applies to every Workflow ended in the pass. --list FILE acts on that saved
# `workflows` listing instead of a fresh one, as fleetd acts on a list a report has outdated since.
reconcile() {
  local name=$1 netboot interval=120 rv="" w now wf_name kept="[]" listfile=""
  shift
  need_vm "$name"
  while [ $# -gt 0 ]; do
    case $1 in
      --interval) interval=$2 && shift 2 ;;
      --rv) rv=$2 && shift 2 ;;
      --list) listfile=$2 && shift 2 ;;
      *) die "reconcile: unknown $1" ;;
    esac
  done
  local list
  if [ -n "$listfile" ]; then list=$(cat "$listfile"); else list=$(workflows "$name"); fi
  now=$(date +%s)
  while read -r w; do
    [ -n "$w" ] || continue
    wf_name=$(jq -r .metadata.name <<<"$w")
    if finished "$(jq -r '.status.state // ""' <<<"$w")"; then
      kept=$(jq -c --argjson w "$w" '. + [$w]' <<<"$kept")
      continue
    fi
    local stop created timeout
    stop=$(jq -r '.status.globalExecutionStop // empty' <<<"$w")
    if [ -n "$stop" ]; then
      kept=$(jq -c --argjson w "$w" '. + [$w]' <<<"$kept")
      if [ $((now - $(date -d "$stop" +%s))) -gt "$interval" ]; then
        KUBE -n "$NS" annotate workflow "$wf_name" --overwrite "lolwtf.ca/overdue-at=$(date -u +%FT%TZ)" >/dev/null
        event event=reconcile-overdue vm="$name" workflow="$wf_name" action=annotated stop="$stop"
      fi
      continue
    fi
    created=$(jq -r '.metadata.creationTimestamp // empty' <<<"$w")
    timeout=$(jq -r '.status.globalTimeout // 0 | if . > 0 then . else 1800 end' <<<"$w")
    if [ -z "$created" ] || [ "$(jq -r '.metadata.labels["lolwtf.ca/action"] // ""' <<<"$w")" = retire ] \
      || [ $((now - $(date -d "$created" +%s) - timeout)) -le "$interval" ]; then
      kept=$(jq -c --argjson w "$w" '. + [$w]' <<<"$kept")
      continue
    fi
    local code body
    body=$(jq -cn --arg rv "${rv:-$(jq -r .metadata.resourceVersion <<<"$w")}" \
      '{apiVersion: "v1", kind: "DeleteOptions", preconditions: {resourceVersion: $rv}}')
    code=$(inns curl -s -o "$dir/delete.out" -w '%{http_code}' -X DELETE --cacert "$dir/pki/ca.crt" \
      --cert "$dir/pki/admin.crt" --key "$dir/pki/admin.key" -H 'Content-Type: application/json' -d "$body" \
      "https://127.0.0.1:6443/apis/tinkerbell.org/v1alpha1/namespaces/$NS/workflows/$wf_name")
    case $code in
      200 | 404)
        event event=reconcile-overdue vm="$name" workflow="$wf_name" action=deleted http="$code" \
          created="$created" global_timeout="$timeout" precondition_rv="${rv:-$(jq -r .metadata.resourceVersion <<<"$w")}" \
          journal="never reported its first action within its global timeout"
        ;;
      409)
        kept=$(jq -c --argjson w "$w" '. + [$w]' <<<"$kept")
        event event=reconcile-overdue vm="$name" workflow="$wf_name" action=kept http=409 \
          precondition_rv="${rv:-$(jq -r .metadata.resourceVersion <<<"$w")}"
        ;;
      *) die "reconcile: end $wf_name: HTTP $code: $(cat "$dir/delete.out")" ;;
    esac
  done < <(jq -c '.[]' <<<"$list")
  netboot=$(jq '[.[] | (.status.state // "") | ltrimstr("STATE_")
    | select(. != "SUCCESS" and . != "FAILED" and . != "TIMEOUT")] | length > 0' <<<"$kept")
  apply_hardware "$name" "$netboot"
  event event=reconcile vm="$name" netboot="$netboot"
}

# wait_cond blocks until COND holds for the machine, or TIMEOUT seconds pass. States are as
# Tinkerbell writes them (PENDING, RUNNING, SUCCESS, FAILED, TIMEOUT); workflow=FINISHED is any of
# the last three. A console condition matches only output written after the wait began.
wait_cond() {
  local name=$1 cond=$2 timeout=${3:-3600} end key val log0 wf state logn=""
  end=$((SECONDS + timeout))
  key=${cond%%=*} val=${cond#*=}
  log0=$(stat -c %s "$(vmdir "$name")/serial.log" 2>/dev/null || echo 0)
  while :; do
    case $key in
      action)
        wf=$(latest "$name")
        [ -n "$wf" ] && [ "$(jq -r --arg a "${val%%:*}" \
          '[.status.tasks[]?.actions[]? | select(.name == $a) | .state][0] // ""' <<<"$wf")" = "${val#*:}" ] && return 0
        ;;
      workflow)
        wf=$(latest "$name")
        if [ -n "$wf" ]; then
          state=$(jq -r '.status.state // ""' <<<"$wf")
          [ "$state" = "$val" ] && return 0
          [ "$val" = FINISHED ] && finished "$state" && return 0
        fi
        ;;
      console)
        tail -c +"$((log0 + 1))" "$(vmdir "$name")/serial.log" 2>/dev/null \
          | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | grep -aqF -- "$val" && return 0
        ;;
      log)
        # log=PROC:TEXT matches a line PROC's log gained after the wait began: tinkerbell (Smee
        # writes HookOS's syslog, and so the agent's, there), dnsmasq (DHCP and DNS queries), ...
        [ -n "$logn" ] || logn=$(wc -l <"$dir/logs/${val%%:*}.log" 2>/dev/null || echo 0)
        tail -n +"$((logn + 1))" "$dir/logs/${val%%:*}.log" 2>/dev/null | grep -aqF -- "${val#*:}" && return 0
        ;;
      *) die "a condition is action=NAME:STATE, workflow=STATE, console=TEXT or log=PROC:TEXT" ;;
    esac
    [ "$SECONDS" -lt "$end" ] || return 124
    sleep 0.5
  done
}

redfish() {
  local name=$1 method=$2 path=$3 body=${4:-} args
  args=(-sk -u tink-lab:tink-lab -X "$method")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  inns curl "${args[@]}" "https://127.0.0.1:$(vmjson "$name" .bmc_port)$path"
}

power() {
  local name=$1 what=$2 reset
  need_vm "$name"
  case $what in
    on) reset=On ;;
    off) reset=ForceOff ;;
    soft) reset=GracefulShutdown ;;
    cycle) reset=PowerCycle ;;
    status)
      redfish "$name" GET "/redfish/v1/Systems/$name" | jq -c '{vm: .Id, power: .PowerState, boot: .Boot}'
      return
      ;;
    *) die "power: on, off, soft, cycle or status" ;;
  esac
  redfish "$name" POST "/redfish/v1/Systems/$name/Actions/ComputerSystem.Reset" "{\"ResetType\":\"$reset\"}" >/dev/null
  event event=power vm="$name" reset="$reset"
}

# qemu_pid prints the machine's QEMU process while it runs. A killed QEMU stays a zombie until its
# BMC next looks, and counts as off.
qemu_pid() {
  local pid
  pid=$(cat "$(vmdir "$1")/qemu.pid" 2>/dev/null || true)
  [ -n "$pid" ] && [ -r "/proc/$pid/stat" ] || return 1
  [ "$(awk '{ print $3 }' "/proc/$pid/stat" 2>/dev/null)" != Z ] || return 1
  echo "$pid"
}
running_vm() { qemu_pid "$1" >/dev/null; }

# power_cut_now kills the machine's QEMU and its swtpm, as a power cut takes the TPM down with the
# board; qemu starts a new swtpm on the next power-on, from the TPM's saved NV state. It returns
# once QEMU is dead, so a power-on right after it is not taken for a machine that is still on.
power_cut_now() {
  local pid
  if pid=$(qemu_pid "$1"); then
    kill -9 "$pid"
    pkill -9 -f "swtpm socket.*$run/$1/swtpm.sock" 2>/dev/null || true
    for _ in $(seq 50); do
      running_vm "$1" || break
      sleep 0.1
    done
    echo "$pid"
  fi
}

# qemu execs the machine's QEMU, with its TPM; the BMC runs it, inside the namespace.
qemu() {
  local name=$1 d disk i=0 bus file serial args=() pci=16 sata=0 opts
  d=$(vmdir "$name")
  opts=$(vmjson "$name" '.drive_opts // ""')
  mkdir -p "$run/$name"
  if ! [ -S "$run/$name/swtpm.sock" ] || ! pgrep -f "swtpm socket.*$run/$name/swtpm.sock" >/dev/null; then
    rm -f "$run/$name/swtpm.sock"
    swtpm socket --tpm2 --tpmstate "dir=$d/tpm" --ctrl "type=unixio,path=$run/$name/swtpm.sock" \
      --daemon --log "file=$d/swtpm.log"
  fi
  while read -r disk; do
    bus=$(jq -r .bus <<<"$disk") file=$(jq -r .file <<<"$disk") serial=$(jq -r .serial <<<"$disk")
    args+=(-drive "if=none,id=d$i,format=raw,file=$file${opts:+,$opts}")
    case $bus in
      virtio)
        args+=(-device "virtio-blk-pci,drive=d$i,serial=$serial,addr=$(printf '0x%x' "$pci")")
        pci=$((pci + 1))
        ;;
      nvme)
        args+=(-device "nvme,drive=d$i,serial=$serial,addr=$(printf '0x%x' "$pci")")
        pci=$((pci + 1))
        ;;
      sata)
        args+=(-device "ide-hd,drive=d$i,bus=ide.$sata,serial=$serial")
        sata=$((sata + 1))
        ;;
      usb) args+=(-device "usb-storage,bus=xhci.0,drive=d$i,serial=$serial,removable=on") ;;
    esac
    i=$((i + 1))
  done < <(jq -c '.disks | map(select(.detached != true)) | sort_by(.slot) | .[]' "$d/vm.json")
  printf '\n==== tink-lab: power on %s ====\n' "$(date -u +%FT%TZ)" >>"$d/serial.log"
  exec qemu-system-x86_64 -name "$name" -machine q35,smm=on,accel=kvm -cpu host -m "$(vmjson "$name" ".mem // $VM_MEM")" -smp "$VM_CPUS" \
    -global driver=cfi.pflash01,property=secure,value=on \
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=$OVMF/OVMF_CODE.fd" \
    -drive "if=pflash,format=raw,unit=1,file=$d/vars.fd" \
    -fw_cfg name=opt/org.tianocore/IPv6PXESupport,string=n \
    -uuid "$(vmjson "$name" '.uuid // "7e1ab000-0000-4000-8000-000000000000"')" \
    -smbios "type=1,manufacturer=tink-lab,product=QEMU,serial=TL$(vmjson "$name" .index)-$name" \
    -chardev "socket,id=chrtpm,path=$run/$name/swtpm.sock" -tpmdev emulator,id=tpm0,chardev=chrtpm \
    -device tpm-tis,tpmdev=tpm0 \
    -netdev "tap,id=n0,ifname=$(vmjson "$name" .tap),script=no,downscript=no" \
    -device "virtio-net-pci,netdev=n0,mac=$(vmjson "$name" .mac),addr=0x3" \
    -device qemu-xhci,id=xhci,addr=0x4 \
    "${args[@]}" \
    -display none \
    -chardev "socket,id=ser0,path=$run/$name/serial.sock,server=on,wait=off,logfile=$d/serial.log,logappend=on" \
    -serial chardev:ser0 \
    -monitor "unix:$run/$name/mon.sock,server,nowait" \
    -qmp "unix:$run/$name/qmp.sock,server,nowait"
}

# efi prints the machine's EFI boot variables from its variable store as JSON, or sets BootNext.
efi() { python3 -I "$here/efivars.py" "$(vmdir "$1")/vars.fd" "${@:2}"; }

console() {
  local name=$1 timeout=$2
  shift 2
  need_vm "$name"
  inns python3 -I "$repo/scripts/tink-vm/console.py" "$run/$name/serial.sock" "$timeout" "$@"
}

observe() {
  local name=$1 with_console=${2:-true} power=Off wfs hw jobs disks efi_ hook=null out
  need_vm "$name"
  running_vm "$name" && power=On
  wfs=$(workflows "$name" | jq -c 'map({name: .metadata.name, created: .metadata.creationTimestamp,
    action: .metadata.labels["lolwtf.ca/action"], hardwareMap: .spec.hardwareMap, state: .status.state,
    current: .status.currentState, agent: .status.agentID, conditions: .status.conditions,
    actions: [.status.tasks[]?.actions[]? | {name, state, message, executionStart, executionStop, executionDuration}]})')
  hw=$(KUBE -n "$NS" get hardware "$name" -o json 2>/dev/null | jq -c '{
    allowPXE: .spec.interfaces[0].netboot.allowPXE, allowWorkflow: .spec.interfaces[0].netboot.allowWorkflow,
    disk: .spec.disks[0].device}' || echo null)
  jobs=$(KUBE -n "$NS" get jobs.bmc.tinkerbell.org -o json 2>/dev/null | jq -c --arg n "$name" '[.items[]
    | select(.spec.machineRef.name == $n)
    | {name: .metadata.name, created: .metadata.creationTimestamp, conditions: .status.conditions}]' || echo null)
  disks=$(jq -c '.disks[]' "$(vmdir "$name")/vm.json" | while read -r disk; do
    f=$(jq -r .file <<<"$disk")
    jq -c --argjson s "$(read_sentinels "$f" "$name-$(jq -r .name <<<"$disk")")" \
      --argjson p "$(python3 -I "$here/diskstate.py" show "$f" 2>/dev/null | jq -c .partitions || echo '[]')" \
      '{name, bus, serial, slot, attached: (.detached != true), intact: ($s | all(.intact)), sentinels: $s,
        partitions: $p}' <<<"$disk"
  done | jq -sc .)
  efi_=$(efi "$name" 2>/dev/null || echo null)
  if [ "$with_console" = true ] && [ "$power" = On ]; then
    # HookOS's shell expands these: each disk's kernel name, serial and bus, and the by-id names.
    # shellcheck disable=SC2016
    local blocks='for b in /sys/block/[sv]d* /sys/block/nvme*; do [ -e $b ] || continue;
      echo "${b##*/} rm=$(cat $b/removable) sectors=$(cat $b/size)
      serial=$( (cat $b/serial || cat $b/device/serial || tail -c +5 $b/device/vpd_pg80) 2>/dev/null | head -n 1 | tr -d " \\000")
      wwid=$(cat $b/wwid $b/device/wwid 2>/dev/null | head -n 1 | tr -d " ") path=$(readlink -f $b)"; done;
      echo ====; ls /dev/disk/by-id | cat'
    if out=$(console "$name" 20 "cat /proc/cmdline; echo ====; nerdctl -n services.linuxkit exec hook-docker ls -la /worker/fleet 2>&1;" \
      "echo code=\$(nerdctl -n services.linuxkit exec hook-docker head -c 4 /worker/fleet/install_code 2>/dev/null); echo ====;" \
      "nerdctl -n services.linuxkit exec hook-docker docker ps -a --no-trunc --format '{{json .}}'; echo ====;" \
      "${blocks//$'\n'/ }" 2>/dev/null); then
      hook=$(python3 -I "$here/hookos-observe.py" <<<"$out")
    else
      hook='"no HookOS shell answered on the serial console"'
    fi
  fi
  event event=observe vm="$name" power="$power" "workflows=$wfs" "hardware=$hw" "rufio_jobs=$jobs" \
    "disks=$disks" "efi=$efi_" "hookos=$hook" \
    "tpm_state=$(cat "$(vmdir "$name")"/tpm/* 2>/dev/null | sha256sum | cut -c1-16)"
}

# ---- processes ----

procs() {
  local v
  echo dnsmasq registry http ntp
  if split; then printf '%s\n' "${COMPONENTS[@]}"; else echo tinkerbell; fi
  for v in "$dir"/vms/*/vm.json; do [ -f "$v" ] && echo "bmc-$(jq -r .name "$v")"; done
  true
}

# kill_proc signals the process itself. Under the supervisor, a Tinkerbell process that dies of
# anything but a clean signal restarts after RESTART_SEC.
kill_proc() {
  local p=$1 sig=${2:-KILL} pid
  pid=$(pidof_ "$p.child")
  [ -n "$pid" ] || pid=$(pidof_ "$p")
  [ -n "$pid" ] || die "$p is not running"
  kill -s "$sig" "$pid"
  event event=kill proc="$p" signal="$sig" pid="$pid"
}

stop_proc() {
  local p=$1 pid
  pid=$(pidof_ "$p")
  [ -n "$pid" ] || return 1
  kill "$pid" 2>/dev/null || true
  rm -f "$dir/pids/$p"
  event event=stop proc="$p" pid="$pid"
}

start_proc() {
  local p=$1
  case $p in
    dnsmasq) start_dnsmasq ;;
    registry) start_registry ;;
    http) start_http ;;
    ntp) start_ntp ;;
    tinkerbell) start_tink ;;
    bmc-*) start_bmc "${p#bmc-}" ;;
    *)
      printf '%s\n' "${COMPONENTS[@]}" | grep -qx -- "$p" || die "no process $p"
      start_tink "$p"
      ;;
  esac
  event event=start proc="$p" pid="$(pidof_ "$p")"
}

# ---- faults ----

agent_net() {
  local name=$1 what=$2 verdict=drop ip
  need_vm "$name"
  [ "${3:-}" = --reject ] && verdict="reject with tcp reset"
  ip=$(vmjson "$name" .ip)
  case $what in
    cut)
      inns nft -f - <<EOF
table inet tinklab_agent_$name {
  chain in { type filter hook input priority -10; ip saddr $ip ip daddr $BOOT tcp dport 42113 $verdict; }
  chain out { type filter hook output priority -10; ip daddr $ip ip saddr $BOOT tcp sport 42113 drop; }
}
EOF
      ;;
    restore) inns nft delete table inet "tinklab_agent_$name" 2>/dev/null || true ;;
    *) die "agent-net: cut or restore" ;;
  esac
  event event=agent-net vm="$name" action="$what" verdict="$verdict"
}

manifest_url() {
  local p
  p=$(push_ref "$1")
  p=${p#"$REG"/}
  echo "http://$REG/v2/${p%:*}/manifests/${2:-${p##*:}}"
}

registry_cmd() {
  local what=${1:-ls} ref digest r verdict rate
  case $what in
    ls)
      inns curl -s "http://$REG/v2/_catalog" | jq -r '.repositories[]' | while read -r r; do
        inns curl -s "http://$REG/v2/$r/tags/list" | jq -c '{repository: .name, tags}'
      done
      ;;
    delete | restore)
      ref=$(images | grep -F -- "${2:?registry $what needs an image}" | head -n 1)
      [ -n "$ref" ] || die "no lab image matches $2"
      if [ "$what" = delete ]; then
        digest=$(inns curl -sI -H 'Accept: application/vnd.oci.image.index.v1+json' \
          -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' "$(manifest_url "$ref")" \
          | tr -d '\r' | awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }')
        [ -n "$digest" ] || die "$ref is not in the registry"
        inns curl -sf -X DELETE "$(manifest_url "$ref" "$digest")" >/dev/null
        event event=registry action=delete image="$ref" digest="$digest"
      else
        skopeo_ inns skopeo copy -q --all --preserve-digests --dest-tls-verify=false \
          "oci:$dir/images/$(cache_name "$ref")" "docker://$(push_ref "$ref")"
        event event=registry action=restore image="$ref"
      fi
      ;;
    deny)
      verdict="reject with tcp reset"
      [ "${2:-}" = --drop ] && verdict=drop
      inns nft -f - <<EOF
table inet tinklab_registry {
  chain in { type filter hook input priority -10; iifname "$BRIDGE" ip daddr $REG tcp dport 80 $verdict; }
}
EOF
      event event=registry action=deny verdict="$verdict"
      ;;
    throttle)
      # Packets from the registry over KBPS kilobytes a second are dropped, so a pull crawls
      # instead of failing. A pull of an image HookOS has cached still fetches only its manifest.
      rate=${2:?registry throttle needs kilobytes a second}
      [[ $rate =~ ^[0-9]+$ ]] || die "registry throttle needs kilobytes a second"
      inns nft -f - <<EOF
table inet tinklab_registry {
  chain out { type filter hook output priority -10; ip saddr $REG tcp sport 80 limit rate over $rate kbytes/second drop; }
}
EOF
      event event=registry action=throttle kbytes_per_second="$rate"
      ;;
    allow)
      inns nft delete table inet tinklab_registry 2>/dev/null || true
      event event=registry action=allow
      ;;
    *) die "registry: ls, delete, restore, deny, throttle or allow" ;;
  esac
}

# template_cmd applies a copy of the committed provision Template as NAME, with each
# --timeout ACTION=SECONDS and --global SECONDS (global_timeout) changed, for a test that varies
# timeouts. --from FILE copies another Template file instead, such as a proposed fix from another
# branch. provision --template NAME runs it.
template_cmd() {
  local name=${1:?template needs a name} data t from=$repo/clusters/folly/tinkerbell/template.yaml
  shift
  [ "$name" != provision ] || die "the copy needs a name other than provision"
  if [ "${1:-}" = --from ]; then
    from=$(realpath "${2:?--from needs a Template file}")
    shift 2
  fi
  data=$(yq -r '.spec.data' "$from")
  [ -n "$data" ] && [ "$data" != null ] || die "$from has no spec.data"
  local os=talos
  while [ $# -gt 0 ]; do
    case $1 in
      --os)
        os=$2 && shift 2
        case $os in
          talos) ;;
          ubuntu) data=$(python3 -I "$here/ubuntu-template.py" <<<"$data") || die "the Ubuntu deltas do not apply to $from" ;;
          *) die "--os is talos or ubuntu" ;;
        esac
        ;;
      --timeout)
        t=$2 && shift 2
        [[ ${t#*=} =~ ^[0-9]+$ ]] || die "--timeout is ACTION=SECONDS"
        yq -e ".tasks[].actions[] | select(.name == \"${t%%=*}\")" <<<"$data" >/dev/null 2>&1 || die "no action ${t%%=*}"
        data=$(yq "(.tasks[].actions[] | select(.name == \"${t%%=*}\") | .timeout) = ${t#*=}" <<<"$data")
        ;;
      --global)
        [[ $2 =~ ^[0-9]+$ ]] || die "--global is SECONDS"
        data=$(yq ".global_timeout = $2" <<<"$data")
        shift 2
        ;;
      *) die "template: unknown $1" ;;
    esac
  done
  jq -n --arg name "$name" --arg ns "$NS" --arg data "$data" '{apiVersion: "tinkerbell.org/v1alpha1",
    kind: "Template", metadata: {name: $name, namespace: $ns}, spec: {data: $data}}' | KUBE apply -f - >/dev/null
  event event=template name="$name" from="$from" os="$os" sha256="$(sha256sum <<<"$data" | cut -c1-16)" \
    "timeouts=$(yq -o json .tasks <<<"$data" | jq -c '[.[].actions[] | {(.name): .timeout}] | add')" \
    global_timeout="$(yq .global_timeout <<<"$data")"
}

# slow_installer pushes ghcr.io/tink-lab/slow-installer:SECONDS: the class's Talos installer, with
# slow-installer.sh in front of /bin/installer. It writes a tick to its install disk every second
# for SECONDS, then runs the real installer with the same arguments.
slow_installer() {
  local secs=${1:?slow-installer needs seconds} base bb stage digest
  [[ $secs =~ ^[0-9]+$ ]] || die "slow-installer needs seconds"
  base=$(push_ref "$(jq -r '[.. | .installer_image? // empty][0]' "$repo/clusters/folly/fleet/class-inputs.json")")
  bb=$(nix build --no-link --print-out-paths nixpkgs#pkgsStatic.busybox)/bin/busybox
  stage=$dir/build/slow-installer
  rm -rf "$stage" && mkdir -p "$stage/tinklab" "$stage/usr/bin"
  inns crane export --insecure --platform linux/amd64 "$base" - | tar -xf - -C "$stage" usr/bin/installer
  mv "$stage/usr/bin/installer" "$stage/tinklab/installer"
  install -m 0755 "$bb" "$stage/tinklab/busybox"
  install -m 0755 "$here/slow-installer.sh" "$stage/usr/bin/installer"
  echo "$secs" >"$stage/tinklab/seconds"
  tar --owner=0 --group=0 --mtime=@0 -C "$stage" -cf "$dir/build/slow-installer.tar" tinklab usr
  inns crane append --insecure --platform linux/amd64 -b "$base" -f "$dir/build/slow-installer.tar" \
    -t "$REG/tink-lab/slow-installer:$secs" >>"$dir/logs/agent.log" 2>&1 || die "the build failed; see $dir/logs/agent.log"
  digest=$(inns crane digest --insecure "$REG/tink-lab/slow-installer:$secs")
  rm -rf "$stage"
  event event=slow-installer seconds="$secs" image="ghcr.io/tink-lab/slow-installer:$secs" digest="$digest"
}

# apk_layer writes STAGE/apk.tar: the files the Alpine image BASE's own apk adds for PKGS (outside
# the namespace, which has no route to Alpine's mirrors) and apk's database.
apk_layer() {
  local base=$1 stage=$2
  shift 2
  mkdir -p "$stage/root"
  inns crane export --insecure --platform linux/amd64 "$base" - | tar -xf - -C "$stage/root"
  cp -L /etc/resolv.conf "$stage/root/etc/resolv.conf"
  # The image's apk, as root in a user namespace of its own, adds the packages and lists what each
  # new one installed; those files and apk's database are the layer. The namespace maps root only,
  # so apk cannot give a file another owner and counts that as an error; the layer is root's anyway,
  # and every package must be installed.
  # shellcheck disable=SC2016
  unshare -rm sh -ec 'r=$1; shift
    mount --rbind /dev "$r/dev"; mount --rbind /proc "$r/proc"
    chroot "$r" /sbin/apk info | sort >"$r/../before"
    chroot "$r" /sbin/apk add -q --no-cache "$@" || chroot "$r" /sbin/apk info -e "$@" >/dev/null
    chroot "$r" /sbin/apk info | sort | comm -13 "$r/../before" - | while read -r p; do
      chroot "$r" /sbin/apk info -qL "$p"; done | sed "/^$/d" >"$r/../files"
    echo lib/apk/db/installed >>"$r/../files"' sh "$stage/root" "$@" >>"$dir/logs/agent.log" 2>&1 \
    || die "apk add failed; see $dir/logs/agent.log"
  tar --owner=0 --group=0 -C "$stage/root" -cf "$stage/apk.tar" -T "$stage/files"
}

# tools_image pushes ghcr.io/tink-lab/tools:TAG and prints it by digest: the Template's tools image,
# with Alpine packages that the image's own apk adds (outside the namespace, which has no route to
# Alpine's mirrors) and DIR's files laid over it. A copy of a Template that pins another tools
# image runs it; the finding that does so must say so.
tools_image() {
  local tag=${1:?tools-image needs a tag} base stage pkgs=() overlay="" layers=() digest
  shift
  [[ $tag =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || die "tools-image needs a tag of lowercase letters, digits, dots and dashes"
  while [ $# -gt 0 ]; do
    case $1 in
      --apk) pkgs+=("$2") && shift 2 ;;
      --overlay) overlay=$(realpath "$2") && shift 2 ;;
      *) die "tools-image: unknown $1" ;;
    esac
  done
  base=$(push_ref "$(images | grep -F /tink-reprovision-tools@ | head -n 1)")
  stage=$dir/build/tools-$tag
  rm -rf "$stage" && mkdir -p "$stage"
  if [ ${#pkgs[@]} -gt 0 ]; then
    apk_layer "$base" "$stage" "${pkgs[@]}"
    layers+=(-f "$stage/apk.tar")
  fi
  if [ -n "$overlay" ]; then
    (cd "$overlay" && find . -mindepth 1 | sort) | tar --owner=0 --group=0 --no-recursion -C "$overlay" -cf "$stage/overlay.tar" -T -
    layers+=(-f "$stage/overlay.tar")
  fi
  [ ${#layers[@]} -gt 0 ] || die "tools-image needs --apk or --overlay"
  inns crane append --insecure --platform linux/amd64 -b "$base" "${layers[@]}" -t "$REG/tink-lab/tools:$tag" \
    >>"$dir/logs/agent.log" 2>&1 || die "the build failed; see $dir/logs/agent.log"
  digest=$(inns crane digest --insecure "$REG/tink-lab/tools:$tag")
  rm -rf "$stage"
  event event=tools-image tag="$tag" image="ghcr.io/tink-lab/tools@$digest" "apk=${pkgs[*]}" overlay="$overlay" >&2
  echo "ghcr.io/tink-lab/tools@$digest"
}

# ubuntu_installer pushes ghcr.io/tink-lab/ubuntu-installer:latest and prints it by digest: the image
# scripts/tink-vm/ubuntu-installer/Dockerfile describes, built without Docker. fetch-image checks the
# cloud image against Ubuntu's signed SHA256SUMS and the pin; the Dockerfile's base, by digest, gets
# the Dockerfile's packages from its own apk (apk_layer), the image and install-ubuntu, and
# install-ubuntu as its entrypoint. The Ubuntu Template (template NAME --os ubuntu) runs it, with
# provision --set installer_image=IMAGE.
ubuntu_installer() {
  local src=$repo/scripts/tink-vm/ubuntu-installer base pkgs img sha stage digest c
  base=$(sed -n 's/^FROM //p' "$src/Dockerfile")
  [[ $base == docker.io/library/alpine:*@sha256:* ]] || die "the Dockerfile's base is not an Alpine image by digest"
  read -ra pkgs <<<"$(sed -n 's/^RUN apk add --no-cache //p' "$src/Dockerfile")"
  [ ${#pkgs[@]} -gt 0 ] || die "the Dockerfile adds no packages"
  img=$("$src/fetch-image" "$dir/downloads/ubuntu" | tail -n 1)
  # fetch-image's gpg leaves its agent and dirmngr running on the throwaway keyring.
  GNUPGHOME=$dir/downloads/ubuntu/gnupg gpgconf --kill all 2>/dev/null || true
  sha=$(sed -n 's/^sha256=//p' "$src/fetch-image")
  [ "$(sha256sum "$img" | cut -d' ' -f1)" = "$sha" ] || die "$img does not match the pin $sha"
  c=$dir/images/$(cache_name "${base#docker.io/}")
  if [ ! -f "$c/index.json" ]; then
    skopeo_ skopeo copy -q --all --preserve-digests "docker://${base%%:*}@${base#*@}" "oci:$c"
  fi
  skopeo_ inns skopeo copy -q --all --preserve-digests --dest-tls-verify=false "oci:$c" \
    "docker://$REG/tink-lab/alpine:sha256-${base#*@sha256:}"
  stage=$dir/build/ubuntu-installer
  rm -rf "$stage" && mkdir -p "$stage/overlay/usr/local/bin"
  apk_layer "$REG/tink-lab/alpine:sha256-${base#*@sha256:}" "$stage" "${pkgs[@]}"
  ln "$img" "$stage/overlay/ubuntu-cloudimg.img" 2>/dev/null || cp "$img" "$stage/overlay/ubuntu-cloudimg.img"
  install -m 0755 "$src/install-ubuntu" "$stage/overlay/usr/local/bin/install-ubuntu"
  tar --owner=0 --group=0 --mtime=@0 -C "$stage/overlay" -cf "$stage/overlay.tar" ubuntu-cloudimg.img usr
  {
    inns crane append --insecure --platform linux/amd64 -b "$REG/tink-lab/alpine:sha256-${base#*@sha256:}" \
      -f "$stage/apk.tar" -f "$stage/overlay.tar" -t "$REG/tink-lab/ubuntu-installer:layers"
    inns crane mutate --insecure "$REG/tink-lab/ubuntu-installer:layers" -t "$REG/tink-lab/ubuntu-installer:latest" \
      --entrypoint /usr/local/bin/install-ubuntu
  } >>"$dir/logs/agent.log" 2>&1 || die "the build failed; see $dir/logs/agent.log"
  digest=$(inns crane digest --insecure "$REG/tink-lab/ubuntu-installer:latest")
  rm -rf "$stage"
  event event=ubuntu-installer image="ghcr.io/tink-lab/ubuntu-installer@$digest" cloud_image_sha256="$sha" \
    "apk=${pkgs[*]}" >&2
  echo "ghcr.io/tink-lab/ubuntu-installer@$digest"
}

# monitor runs each line of stdin as a monitor command, through QMP, which answers before the
# connection closes.
monitor() {
  local line
  {
    echo '{"execute": "qmp_capabilities"}'
    while IFS= read -r line; do
      jq -cn --arg c "$line" '{execute: "human-monitor-command", arguments: {"command-line": $c}}'
    done
  } | inns socat -t 5 - "UNIX-CONNECT:$run/$1/qmp.sock" | jq -c 'select(.return != null and .return != {}) | .return' >&2
}

disk_cmd() {
  local name=$1 what=$2 d dname size serial disk
  need_vm "$name"
  d=$(vmdir "$name")
  case $what in
    sentinel)
      jq -c '.disks[]' "$d/vm.json" | while read -r disk; do
        write_sentinels "$(jq -r .file <<<"$disk")" "$name-$(jq -r .name <<<"$disk")"
      done
      event event=disk vm="$name" action=sentinel
      ;;
    shuffle)
      # Reverses the order in which the disks take PCI slots and SATA ports, from the next power-on.
      jq '.disks |= (sort_by(.slot) | reverse | to_entries | map(.value + {slot: .key}))' "$d/vm.json" >"$d/vm.json.new"
      mv "$d/vm.json.new" "$d/vm.json"
      event event=disk vm="$name" action=shuffle "order=$(jq -c '[.disks | sort_by(.slot)[] | .name]' "$d/vm.json")"
      ;;
    usb-attach)
      dname=${3:?usb-attach needs a disk name} size=${4:-2G}
      serial=tl$(vmjson "$name" .index)$dname
      truncate -s "$size" "$d/$dname.img"
      write_sentinels "$d/$dname.img" "$name-$dname"
      jq --arg n "$dname" --arg f "$d/$dname.img" --arg s "$serial" \
        '.disks += [{name: $n, bus: "usb", serial: $s, file: $f, slot: (.disks | length)}]' "$d/vm.json" >"$d/vm.json.new"
      mv "$d/vm.json.new" "$d/vm.json"
      if running_vm "$name"; then
        printf 'drive_add 0 if=none,id=usb-%s,format=raw,file=%s\ndevice_add usb-storage,bus=xhci.0,drive=usb-%s,id=usb-%s,serial=%s,removable=on\n' \
          "$dname" "$d/$dname.img" "$dname" "$dname" "$serial" | monitor "$name"
      fi
      event event=disk vm="$name" action=usb-attach disk="$dname" serial="$serial" hotplug="$(running_vm "$name" && echo true || echo false)"
      ;;
    detach | attach)
      # Takes a disk out of the machine, or puts it back, from the next power-on. A USB disk is
      # also unplugged or plugged in at once when the machine runs. The image and its sentinels
      # stay, and observe still reads them.
      dname=${3:?$what needs a disk name}
      disk=$(jq -c --arg n "$dname" '.disks[] | select(.name == $n)' "$d/vm.json")
      [ -n "$disk" ] || die "$name has no disk $dname"
      if running_vm "$name" && [ "$(jq -r .bus <<<"$disk")" = usb ]; then
        if [ "$what" = detach ]; then
          printf 'device_del usb-%s\n' "$dname" | monitor "$name" || true
        else
          printf 'drive_add 0 if=none,id=usb-%s,format=raw,file=%s\ndevice_add usb-storage,bus=xhci.0,drive=usb-%s,id=usb-%s,serial=%s,removable=on\n' \
            "$dname" "$(jq -r .file <<<"$disk")" "$dname" "$dname" "$(jq -r .serial <<<"$disk")" | monitor "$name"
        fi
      fi
      jq --arg n "$dname" --argjson off "$([ "$what" = detach ] && echo true || echo false)" \
        '.disks |= map(if .name == $n then .detached = $off else . end)' "$d/vm.json" >"$d/vm.json.new"
      mv "$d/vm.json.new" "$d/vm.json"
      event event=disk vm="$name" action="$what" disk="$dname" \
        "attached=$(jq -c '[.disks | sort_by(.slot)[] | select(.detached != true) | .name]' "$d/vm.json")"
      ;;
    data | scan)
      # data appends a partition named data over the disk's free space and writes a record every
      # STEP bytes of it (default 256 KiB), as a volume's contents; scan reads the whole image for
      # the MiB that still hold anything and the lab's records left in them.
      dname=${3:?$what needs a disk name}
      disk=$(jq -r --arg n "$dname" '.disks[] | select(.name == $n) | .file' "$d/vm.json")
      [ -n "$disk" ] || die "$name has no disk $dname"
      if [ "$what" = data ]; then
        running_vm "$name" && die "power $name off before writing its disks"
        printf 'name=data\n' | sfdisk -q --append "$disk" >/dev/null
        event event=disk vm="$name" action=data disk="$dname" \
          "result=$(python3 -I "$here/diskstate.py" fill "$disk" "$name-$dname" "${4:-262144}")"
      else
        event event=disk vm="$name" action=scan disk="$dname" "result=$(python3 -I "$here/diskstate.py" scan "$disk")"
      fi
      ;;
    *) die "disk: sentinel, shuffle, usb-attach, detach, attach, data or scan" ;;
  esac
}

# parse_when takes --when and --delay out of a hook's arguments; at_boundary waits for them.
when="" delay=0 rest=()
parse_when() {
  while [ $# -gt 0 ]; do
    case $1 in
      --when) when=$2 && shift 2 ;;
      --delay) delay=$2 && shift 2 ;;
      *) rest+=("$1") && shift ;;
    esac
  done
}
# watch_action blocks until ACTION of the machine's newest Workflow is in STATE. It reads a watch
# on the API, not a poll, so a hook acts within tens of milliseconds of the agent's report: an
# action such as next-boot runs for 0.2 s after it reports RUNNING.
watch_action() {
  local name=$1 act=${2%%:*} want=${2#*:} timeout=$3 state pid rc=124
  exec {w}< <(exec timeout "$timeout" nsenter -t "$(nspid)" -U -n --preserve-credentials -- \
    kubectl --kubeconfig "$dir/pki/kubeconfig" -n "$NS" get workflows -l "lolwtf.ca/node=$name" -w -o json \
    | jq -n --unbuffered -r --arg a "$act" 'foreach inputs as $w ({latest: ""};
        if $w.metadata.creationTimestamp >= .latest then
          .latest = $w.metadata.creationTimestamp
          | .out = ([$w.status.tasks[]?.actions[]? | select(.name == $a) | .state][0] // "")
        else .out = null end; .out // empty)')
  pid=$!
  while IFS= read -r -u "$w" state; do
    if [ "$state" = "$want" ]; then
      rc=0
      break
    fi
  done
  exec {w}<&-
  pkill -P "$pid" 2>/dev/null || true
  return "$rc"
}

# watch_console blocks until the machine's serial console prints TEXT. It follows the log with
# inotify, so a hook acts within milliseconds of the line, where wait_cond polls every 0.5 s.
watch_console() {
  local name=$1 text=$2 timeout=$3 line pid rc=124
  exec {c}< <(exec timeout "$timeout" tail -n 0 -F "$(vmdir "$name")/serial.log" 2>/dev/null \
    | sed -u 's/\x1b\[[0-9;?]*[a-zA-Z]//g')
  pid=$!
  while IFS= read -r -u "$c" line; do
    if [[ $line == *"$text"* ]]; then
      rc=0
      break
    fi
  done
  exec {c}<&-
  pkill -P "$pid" 2>/dev/null || true
  return "$rc"
}

# watch_disk blocks until the machine's disk DISK gains STAGE (gpt, esp or meta), read from its
# image every 20 ms (diskstate.py).
watch_disk() {
  local name=$1 disk=${2%%:*} stage=${2#*:} timeout=$3 file
  file=$(jq -r --arg d "$disk" '.disks[] | select(.name == $d) | .file' "$(vmdir "$name")/vm.json")
  [ -n "$file" ] || die "machine $name has no disk $disk"
  python3 -I "$here/diskstate.py" watch "$file" "$stage" "$timeout"
}

at_boundary() {
  local name=$1 start=$SECONDS
  if [ -n "$when" ]; then
    case $when in
      action=*) watch_action "$name" "${when#action=}" "${TINK_LAB_WHEN_TIMEOUT:-3600}" || die "$when did not hold" ;;
      console=*) watch_console "$name" "${when#console=}" "${TINK_LAB_WHEN_TIMEOUT:-3600}" || die "$when did not hold" ;;
      disk=*) watch_disk "$name" "${when#disk=}" "${TINK_LAB_WHEN_TIMEOUT:-3600}" || die "$when did not hold" ;;
      *) wait_cond "$name" "$when" "${TINK_LAB_WHEN_TIMEOUT:-3600}" || die "$when did not hold" ;;
    esac
    event event=boundary vm="$name" when="$when" waited="$((SECONDS - start))"
  fi
  [ "$delay" = 0 ] || sleep "$delay"
}

# ---- fleetd in the loop ----

# fleetd_build builds fleet/main.go against apps/fleetd at FLEETD_REF (default origin/main), with
# fleet/redfish-machine.patch, which lets Config.Machine write the Redfish Machine the VMs' BMCs
# answer where the lab has AMT. The build is kept until the ref, main.go or the patch changes.
FLEETD_REF=${TINK_LAB_FLEETD_REF:-origin/main}
NETBOX_PORT=8000
FLEETD_PORT=8446
# fleetd's boot listener, which serves the config to the installed node over HTTP; the lab's serves
# HTTPS on 443 for the enrollment name.
CONFIG_PORT=8447
fleetd_build() {
  local rev key src=$dir/fleetd/src
  rev=$(git -C "$repo" rev-parse "$FLEETD_REF")
  key="$rev $(cat "$here/fleetd/main.go" "$here/fleetd/redfish-machine.patch" | sha256sum | cut -c1-16)"
  if [ "$(cat "$dir/fleetd/rev" 2>/dev/null)" = "$key" ] && [ -x "$dir/fleetd/tink-lab-fleetd" ]; then return; fi
  rm -rf "$src" && mkdir -p "$src"
  git -C "$repo" archive "$rev" apps/fleetd | tar -x -C "$src"
  patch -s -d "$src" -p1 <"$here/fleetd/redfish-machine.patch"
  mkdir -p "$src/apps/fleetd/cmd/tink-lab-fleetd"
  cp "$here/fleetd/main.go" "$src/apps/fleetd/cmd/tink-lab-fleetd/main.go"
  (cd "$src/apps/fleetd" && go build -o "$dir/fleetd/tink-lab-fleetd" ./cmd/tink-lab-fleetd) || die "the fleetd build failed"
  echo "$key" >"$dir/fleetd/rev"
  event event=fleetd-build ref="$FLEETD_REF" rev="$rev" >/dev/null
}

# fleetd_device writes the machines' NetBox devices and interfaces in the shape fleetd reads
# (parseDevice in apps/fleetd/fleet/netbox.go), each with the machine's index as its ID: a worker-g5
# with a TPM 2.0, attested, its declared disk and serial, and bmc_type redfish at oob_ip 127.0.0.1,
# where its BMC listens on its own port.
fleetd_device() {
  local status=$1 name devs='[]' ifs='[]' dev
  shift
  for name in "$@"; do
    dev=$(jq -c --arg status "$status" '{name, index, ip, mac, install_disk, uuid,
      serial: (.install_disk_serial // "")} as $m | {
      devices: [{id: $m.index, name: $m.name, serial: ("TL-" + $m.name), status: {value: $status},
        primary_ip4: {address: ($m.ip + "/24")}, oob_ip: {address: "127.0.0.1/32"},
        device_type: {model: "tink-lab VM"}, description: "",
        custom_fields: {install_disk: $m.install_disk, install_disk_serial: $m.serial, talos_class: "worker-g5",
          tpm_version: "2.0", bmc_type: "redfish", amt: false, secure_boot_expected: false,
          desired_action: "none", last_workflow: "", expected_port: null, smbios_uuid: $m.uuid,
          attest_verdict: "attested"}}],
      interfaces: [{id: $m.index, name: "eth0", type: {value: "1000base-t"}, device: {id: $m.index},
        primary_mac_address: {mac_address: $m.mac}}]}' "$(vmdir "$name")/vm.json")
    devs=$(jq -c --argjson d "$dev" '. + $d.devices' <<<"$devs")
    ifs=$(jq -c --argjson d "$dev" '. + $d.interfaces' <<<"$ifs")
  done
  jq -n --argjson d "$devs" --argjson i "$ifs" '{devices: $d, interfaces: $i}' >"$dir/fleetd/netbox/devices.json"
}

# fleetd_start runs netbox.py and the fleetd build for the machines named, which are NetBox's only
# devices: fleetd deletes the Hardware and Machine of every other machine, as it does for a device
# NetBox no longer lists. The classes are clusters/folly/fleet/classes.json with each Template named TEMPLATE.
fleetd_start() {
  local name=${1:?fleetd start needs a machine} names=() tmpl=provision interval=2m status=active installer="" installs ttl=1h ports
  while [ $# -gt 0 ] && [[ $1 != --* ]]; do
    need_vm "$1"
    names+=("$1")
    shift
  done
  while [ $# -gt 0 ]; do
    case $1 in
      --template) tmpl=$2 && shift 2 ;;
      --interval) interval=$2 && shift 2 ;;
      --status) status=$2 && shift 2 ;;
      --installer) installer=$2 && shift 2 ;;
      --config-ttl) ttl=$2 && shift 2 ;;
      *) die "fleetd start: unknown $1" ;;
    esac
  done
  alive fleetd && die "fleetd runs; fleetd stop first"
  fleetd_build
  mkdir -p "$dir/fleetd/netbox"
  : >"$dir/fleetd/netbox/writes.jsonl"
  rm -f "$dir/fleetd/hold" "$dir/fleetd"/config*.json
  fleetd_device "$status" "${names[@]}"
  ports=$(for n in "${names[@]}"; do printf '%s=%s,' "$n" "$(vmjson "$n" .bmc_port)"; done)
  jq --arg t "$tmpl" 'map_values(.template = $t)' "$repo/clusters/folly/fleet/classes.json" >"$dir/fleetd/classes.json"
  (umask 077 && echo tink-lab >"$dir/fleetd/netbox-token" && openssl rand -hex 32 >"$dir/fleetd/webhook-secret")
  installs=$(jq -r --arg i "$installer" 'to_entries | map("\(.key)=\(if $i != "" then $i else .value.installer_image end)")
    | join(",")' "$repo/clusters/folly/fleet/class-inputs.json")
  daemon netbox python3 -I "$here/netbox.py" "$NETBOX_PORT" "$dir/fleetd/netbox"
  local end=$((SECONDS + 10))
  until inns curl -sf -o /dev/null "http://127.0.0.1:$NETBOX_PORT/api/dcim/interfaces/"; do
    [ "$SECONDS" -lt "$end" ] || die "netbox.py did not answer; see $dir/logs/netbox.log"
    sleep 0.2
  done
  printf '%s\0' FLEET_SITE="$SITE" FLEET_NAMESPACE="$NS" FLEET_INTERVAL="$interval" \
    FLEET_HOOKOS_URL="http://$BOOT/talos/$SITE/$UKI" \
    FLEET_HOOKOS_CMDLINE="$(cmdline "$(cat "$dir/agent.digest")" "$(vmjson "$name" .attest)")" \
    FLEET_CLASSES="$dir/fleetd/classes.json" FLEET_BMC_SECRETS=redfish=bmc-redfish \
    FLEET_NETBOX_URL="http://127.0.0.1:$NETBOX_PORT" FLEET_NETBOX_TOKEN_FILE="$dir/fleetd/netbox-token" \
    FLEET_KUBE_SERVER=https://127.0.0.1:6443 FLEET_KUBE_CA_FILE="$dir/pki/ca.crt" \
    FLEET_KUBE_CERT_FILE="$dir/pki/admin.crt" FLEET_KUBE_KEY_FILE="$dir/pki/admin.key" \
    FLEET_WEBHOOK_SECRET_FILE="$dir/fleetd/webhook-secret" FLEET_WEBHOOK_ADDR="127.0.0.1:$FLEETD_PORT" \
    TINK_LAB_BMC_PORT="$(vmjson "$name" .bmc_port)" TINK_LAB_BMC_PORTS="${ports%,}" TINK_LAB_HOLD_FILE="$dir/fleetd/hold" \
    TINK_LAB_INSTALLS="$installs" TINK_LAB_BOOT_ADDR="$BOOT:$CONFIG_PORT" TINK_LAB_CONFIG_TTL="$ttl" >"$dir/fleetd/env"
  fleetd_run
  end=$((SECONDS + 15))
  until inns curl -sf -o /dev/null "http://127.0.0.1:$FLEETD_PORT/metrics" && alive fleetd; do
    alive fleetd || die "fleetd exited; see $dir/logs/fleetd.log"
    [ "$SECONDS" -lt "$end" ] || die "fleetd did not answer; see $dir/logs/fleetd.log"
    sleep 0.2
  done
  event event=fleetd-start vm="${names[*]}" rev="$(cat "$dir/fleetd/rev")" template="$tmpl" interval="$interval" status="$status" \
    installs="$installs" config_ttl="$ttl"
}

# fleetd_run starts the fleetd process with the environment fleetd_start wrote, so a restart keeps
# netbox.py, its device and the webhook secret, as a restart of spore's unit keeps NetBox.
fleetd_run() {
  local vars
  [ -f "$dir/fleetd/env" ] || die "no fleetd environment; run fleetd start first"
  mapfile -d '' -t vars <"$dir/fleetd/env"
  daemon fleetd env "${vars[@]}" "$dir/fleetd/tink-lab-fleetd"
}

# fleetd_restart stops the fleetd process alone and starts it again after DOWN seconds (default
# 5, the unit's RestartSec), as systemd does after a crash or a deploy. --kill sends SIGKILL, so no
# pass finishes; the default SIGTERM lets the process shut down.
fleetd_restart() {
  local down=5 sig=TERM pid
  while [ $# -gt 0 ]; do
    case $1 in
      --down) down=$2 && shift 2 ;;
      --kill) sig=KILL && shift ;;
      *) die "fleetd restart: unknown $1" ;;
    esac
  done
  pid=$(pidof_ fleetd)
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then die "fleetd is not running"; fi
  kill -s "$sig" "$pid"
  while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
  rm -f "$dir/pids/fleetd"
  event event=stop proc=fleetd pid="$pid" signal="$sig"
  sleep "$down"
  fleetd_run
  event event=start proc=fleetd pid="$(pidof_ fleetd)"
}

# host_restart stands in for a reboot of spore: Tinkerbell (every part, with split), fleetd, the
# registry, the HTTP server and NTP stop, and after DOWN seconds start again in up's order. The
# machines, their BMCs (AMT is on the node), netbox.py (NetBox runs on capsule) and dnsmasq (DHCP
# and DNS are UniFi's) keep running. etcd's directory survives, as spore's /var/lib/tinkerbell
# does on its NVMe root.
host_restart() {
  local down=${1:-0} p pid procs_=(fleetd registry http ntp) fleetd_was=false
  alive fleetd && fleetd_was=true
  if split; then procs_+=("${COMPONENTS[@]}"); else procs_+=(tinkerbell); fi
  for p in "${procs_[@]}"; do
    pid=$(pidof_ "$p.child")
    [ -n "$pid" ] || pid=$(pidof_ "$p")
    stop_proc "$p" || true
    while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
  done
  sleep "$down"
  if split; then
    start_tink etcd
    start_tink apiserver
  fi
  start_tink
  start_registry
  start_http
  start_ntp
  api_ready 180
  if [ "$fleetd_was" = true ]; then fleetd_run; fi
  event event=host-restart down="$down" procs="${procs_[*]}" fleetd="$fleetd_was"
}

# webhook posts N signed copies of a NetBox device webhook to fleetd at once, as NetBox's event
# rule does on each device update.
webhook() {
  local n=${1:-1} body sig i codes
  body='{"event": "updated", "model": "device", "data": {"id": 1}}'
  sig=$(printf '%s' "$body" | openssl dgst -sha512 -hmac "$(cat "$dir/fleetd/webhook-secret")" -hex | sed 's/^.*= //')
  codes=$(for i in $(seq "$n"); do
    inns curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "X-Hook-Signature: $sig" \
      -H 'Content-Type: application/json' -d "$body" "http://127.0.0.1:$FLEETD_PORT/webhook" &
  done | sort | uniq -c | awk '{ printf "{\"%s\": %s}\n", $2, $1 }' | jq -sc add)
  event event=webhook count="$n" "http=$codes"
}

# fleetd_hold keeps fleetd's NetBox requests whose "METHOD PATH?QUERY" matches REGEX unsent until
# fleetd release, so a test can act, or kill fleetd, between two of its NetBox calls. fleetd logs
# "tink-lab: holding" when a request starts to wait. A request held past the client's 30 s timeout
# fails as a NetBox that does not answer does.
fleetd_hold() {
  case ${1:?fleetd hold needs a REGEX, or release} in
    release)
      rm -f "$dir/fleetd/hold"
      event event=fleetd-hold action=release
      ;;
    *)
      printf '%s\n' "$1" >"$dir/fleetd/hold"
      event event=fleetd-hold action=hold "pattern=$1"
      ;;
  esac
}

# config_cmd puts a config for the machine in fleetd's Installer, as a render at intake does, with a
# fresh code and the Workflow NetBox names, or fetches it as the installed node's first boot does
# (GET /talos/config), and records the HTTP status. --file puts that file's bytes (a stand-in line
# by default), and --meta-code the code the install wrote to META, which the installed node sends.
config_cmd() {
  local name=${1:?config needs a machine} code uuid wf rc file="" meta=false
  need_vm "$name"
  uuid=$(vmjson "$name" .uuid)
  case ${2:-} in
    put)
      shift 2
      while [ $# -gt 0 ]; do
        case $1 in
          --file) file=$2 && shift 2 ;;
          --meta-code) meta=true && shift ;;
          *) die "config put: unknown $1" ;;
        esac
      done
      if [ "$meta" = true ]; then
        code=$(python3 -I "$here/diskstate.py" code "$(jq -r '.disks[0].file' "$(vmdir "$name")/vm.json")") \
          || die "config: no code in $name's META"
      else
        code=$(openssl rand 32 | basenc --base64url | tr -d '=\n')
      fi
      wf=$(jq -r --arg n "$name" '.devices[] | select(.name == $n) | .custom_fields.last_workflow' "$dir/fleetd/netbox/devices.json")
      if [ -n "$file" ]; then base64 -w0 "$file"; fi >"$dir/fleetd/config.b64"
      jq -n --arg u "$uuid" --arg c "$code" --arg n "$name" --arg w "$wf" --rawfile b "$dir/fleetd/config.b64" \
        '{UUID: $u, Code: $c, Serial: ("TL-" + $n), Node: $n, Class: "worker-g5", Workflow: $w}
          + (if $b != "" then {Config: $b} else {} end)' >"$dir/fleetd/config-$name.json"
      rm -f "$dir/fleetd/config.b64"
      rc=$(inns curl -s -o /dev/null -w '%{http_code}' -X POST -d @"$dir/fleetd/config-$name.json" "http://127.0.0.1:$FLEETD_PORT/lab/config")
      event event=config vm="$name" action=put workflow="$wf" code="${code:0:4}" http="$rc" \
        bytes="$(if [ -n "$file" ]; then wc -c <"$file"; else echo 0; fi)" meta_code="$meta"
      ;;
    fetch)
      [ -f "$dir/fleetd/config-$name.json" ] || die "config: no config put for $name"
      code=$(jq -r .Code "$dir/fleetd/config-$name.json")
      rc=$(inns curl -s -o "$dir/fleetd/config-$name.out" -w '%{http_code}' "http://127.0.0.1:$FLEETD_PORT/talos/config?uuid=$uuid&code=$code")
      event event=config vm="$name" action=fetch code="${code:0:4}" http="$rc" "body=$(head -c 200 "$dir/fleetd/config-$name.out")"
      ;;
    *) die "config: NAME put or NAME fetch" ;;
  esac
}

# config_net drops fleetd's boot listener's packets to the machine once the connection's answer
# has carried BYTES (default 0) bytes, counted as conntrack counts them: IP and TCP headers
# included. fleetd's kernel keeps retransmitting what the drop eats, as across a network that
# dies, until restore. While cut, the bridge takes no segmentation offload (gso_max_segs 1), so
# each packet is one MSS and the cut falls inside a small answer; with offload, one write leaves
# as one packet, and the cut drops all of it.
config_net() {
  local name=$1 what=$2 after=0 ip
  need_vm "$name"
  [ "${3:-}" = --after ] && after=$4
  ip=$(vmjson "$name" .ip)
  case $what in
    cut)
      inns sh -c "echo 1 >/proc/sys/net/netfilter/nf_conntrack_acct; ip link set dev $BRIDGE gso_max_segs 1"
      inns nft -f - <<NFT
table inet tinklab_config_$name {
  chain out { type filter hook output priority -10; ip daddr $ip ip saddr $BOOT tcp sport $CONFIG_PORT ct reply bytes > $after drop; }
}
NFT
      ;;
    restore)
      inns nft delete table inet "tinklab_config_$name" 2>/dev/null || true
      inns ip link set dev "$BRIDGE" gso_max_segs 65535
      ;;
    *) die "config-net: cut or restore" ;;
  esac
  event event=config-net vm="$name" action="$what" after="$after"
}

# talos_boot adds a systemd-boot entry on the machine's ESP that boots the installed UKI with its
# own command line, but talos.config at fleetd's boot listener over HTTP and console=ttyS0 added,
# so the serial log carries Talos's fetch. It deletes the LoaderEntryDefault the installer set, so
# loader.conf's default picks the entry. Secure Boot is off, so systemd-stub takes the entry's
# options. reset removes the entry; the UKI boots as systemd-boot's first entry. The machine must
# be off.
talos_boot() {
  local name=${1:?talos-boot needs a machine} what=${2:-} img start at uki cmdline tmp url
  need_vm "$name"
  running_vm "$name" && die "talos-boot: power $name off first"
  img=$(jq -r '.disks[0].file' "$(vmdir "$name")/vm.json")
  start=$(sfdisk -J "$img" | jq '.partitiontable.partitions[] | select(.name == "EFI") | .start')
  [ -n "$start" ] || die "talos-boot: $name's disk has no EFI partition"
  at="$img@@$((start * 512))"
  tmp=$(mktemp)
  case $what in
    http)
      uki=$(mdir -b -i "$at" ::/EFI/Linux | grep -m 1 -E 'Talos-[^/]*\.efi$') || die "talos-boot: no Talos UKI"
      cmdline=$(mtype -i "$at" "$uki" | python3 -I "$here/diskstate.py" cmdline)
      url="http://$BOOT:$CONFIG_PORT/talos/config?uuid=\${uuid}&code=\${code}"
      cmdline=$(awk -v u="$url" '{ for (i = 1; i <= NF; i++) if ($i ~ /^talos\.config=/) $i = "talos.config=" u; print }' <<<"$cmdline")
      printf 'title tink-lab Talos, config over HTTP\nefi %s\noptions %s console=ttyS0\n' "${uki#::}" "$cmdline" >"$tmp"
      mmd -i "$at" ::/loader/entries 2>/dev/null || true
      mcopy -o -i "$at" "$tmp" ::/loader/entries/tink-lab.conf
      mtype -i "$at" ::/loader/loader.conf | grep -v '^default ' >"$tmp" || true
      echo 'default tink-lab.conf' >>"$tmp"
      mcopy -o -i "$at" "$tmp" ::/loader/loader.conf
      # The installer sets LoaderEntryDefault to its UKI, which overrides loader.conf's default.
      virt-fw-vars -i "$(vmdir "$name")/vars.fd" -o "$tmp" -d LoaderEntryDefault >/dev/null
      cp "$tmp" "$(vmdir "$name")/vars.fd"
      event event=talos-boot vm="$name" action=http "options=$cmdline console=ttyS0"
      ;;
    reset)
      mdel -i "$at" ::/loader/entries/tink-lab.conf 2>/dev/null || true
      mtype -i "$at" ::/loader/loader.conf | grep -v '^default ' >"$tmp" || true
      mcopy -o -i "$at" "$tmp" ::/loader/loader.conf
      event event=talos-boot vm="$name" action=reset
      ;;
    *) die "talos-boot: NAME http or NAME reset" ;;
  esac
  rm -f "$tmp"
}

# bmc_cmd makes the machine's BMC refuse its power actions with a 500, or perform them again.
bmc_cmd() {
  local name=${1:?bmc needs a machine}
  need_vm "$name"
  case ${2:-}:${3:-} in
    fail-power:on) echo power >"$(vmdir "$name")/fault" ;;
    fail-power:off) rm -f "$(vmdir "$name")/fault" ;;
    *) die "bmc: NAME fail-power on|off" ;;
  esac
  event event=bmc vm="$name" fail_power="$3"
}

# netbox_cmd edits the machine's device as the owner does, then rings the webhook --webhooks N
# times (default 1), or shows the device, fleetd's writes, or makes fleetd's PATCHes fail.
netbox_cmd() {
  local name=${1:?netbox needs a machine, writes or fail-patch} hooks=1 kv patch='{"custom_fields": {}}'
  shift
  case $name in
    writes)
      cat "$dir/fleetd/netbox/writes.jsonl"
      return
      ;;
    fail-patch)
      inns curl -s -X PUT -d "{\"on\": $([ "${1:-}" = on ] && echo true || echo false)}" \
        "http://127.0.0.1:$NETBOX_PORT/lab/fail-patch" >/dev/null
      event event=netbox fail_patch="${1:-off}"
      return
      ;;
  esac
  [ "${1:-}" = show ] && {
    jq -c --arg n "$name" '.devices[] | select(.name == $n) | {status: .status.value,
      desired_action: .custom_fields.desired_action, last_workflow: .custom_fields.last_workflow}' \
      "$dir/fleetd/netbox/devices.json"
    return
  }
  [ "${1:-}" = set ] && shift
  while [ $# -gt 0 ]; do
    case $1 in
      --webhooks) hooks=$2 && shift 2 && continue ;;
      status=*) patch=$(jq -c --arg v "${1#status=}" '.status = $v' <<<"$patch") ;;
      *=*) kv=$1 && patch=$(jq -c --arg k "${kv%%=*}" --arg v "${kv#*=}" '.custom_fields[$k] = $v' <<<"$patch") ;;
      *) die "netbox: KEY=VALUE, status=S or --webhooks N" ;;
    esac
    shift
  done
  inns curl -sf -X PATCH -H 'Content-Type: application/json' -d "$patch" \
    "http://127.0.0.1:$NETBOX_PORT/lab/devices/$name" >/dev/null || die "netbox: the edit failed"
  event event=netbox vm="$name" "patch=$patch"
  [ "$hooks" = 0 ] || webhook "$hooks"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case $cmd in
  _supervise) supervise "$@" ;;
  _qemu)
    tools
    qemu "$1"
    ;;
  _bootnext)
    tools
    efi "$1" --boot-next "$2"
    ;;
  up) up ;;
  selftest)
    tools
    selftest "$@"
    ;;
  down) down ;;
  reset)
    down
    rm -rf "${dir:?}/state" "$dir/registry" "$dir/vms" "$dir/pki" "$dir/logs" "$dir/pids" \
      "$dir/dhcp-hosts" "$dir/events.jsonl" "$dir/split" "$dir/agent.digest" "$dir/fleetd/netbox" "${run:?}"
    ;;
  status)
    tools
    for p in $(procs); do
      jq -cn --arg p "$p" --arg pid "$(pidof_ "$p")" --arg child "$(pidof_ "$p.child")" \
        --argjson up "$(alive "$p" && echo true || echo false)" '{proc: $p, up: $up, pid: $pid, child: $child}'
    done
    for v in "$dir"/vms/*/vm.json; do [ -f "$v" ] && power "$(jq -r .name "$v")" status; done
    true
    ;;
  kubectl)
    tools
    KUBE "$@"
    ;;
  sh)
    tools
    inns bash "$@"
    ;;
  vm)
    tools
    sub=${1:?vm create, delete or console}
    shift
    case $sub in
      create) vm_create "$@" ;;
      delete) vm_delete "$@" ;;
      console) console "$@" ;;
      screen)
        # The VGA screen as PNG: Talos writes to tty0 only.
        need_vm "${1:?vm screen needs a machine}"
        jq -cn --arg f "$(realpath -m "${2:?vm screen needs a file}")" '{"execute": "qmp_capabilities"},
          {execute: "screendump", arguments: {filename: $f, format: "png"}}' \
          | inns socat -t 5 - "UNIX-CONNECT:$run/$1/qmp.sock" | jq -c 'select(.error) | .error' >&2
        ;;
      *) die "vm: create, delete, console or screen" ;;
    esac
    ;;
  provision)
    tools
    provision "$@"
    ;;
  reconcile)
    tools
    reconcile "${1:?reconcile needs a machine}" "${@:2}"
    ;;
  wait)
    tools
    # Exits 0 when the latest Workflow reaches STATE (default FINISHED) and it is SUCCESS or the
    # STATE asked for, 1 for another state, and 124 on the timeout.
    rc=0
    want=${3:-FINISHED}
    wait_cond "${1:?wait needs a machine}" "workflow=$want" "${2:-1800}" || rc=$?
    wf=$(latest "$1" | jq -c '{name: .metadata.name, state: .status.state}')
    if [ "$rc" = 0 ] && [ "$want" = FINISHED ] && [ "$(jq -r .state <<<"$wf")" != SUCCESS ]; then rc=1; fi
    event event=wait vm="$1" "workflow=$wf" status="$rc"
    exit "$rc"
    ;;
  power)
    tools
    power "$@"
    ;;
  cut)
    tools
    parse_when "$@"
    name=${rest[0]:?cut needs a machine}
    need_vm "$name"
    on_after=""
    [ "${rest[1]:-}" = --on-after ] && on_after=${rest[2]}
    at_boundary "$name"
    pid=$(power_cut_now "$name")
    event event=power-cut vm="$name" when="$when" delay="$delay" pid="${pid:-none}"
    if [ -n "$on_after" ]; then
      sleep "$on_after"
      power "$name" on
    fi
    ;;
  agent-net)
    tools
    parse_when "$@"
    at_boundary "${rest[0]:?agent-net needs a machine}"
    agent_net "${rest[@]}"
    ;;
  kill)
    tools
    parse_when "$@"
    sig=KILL
    [ "${rest[1]:-}" = --signal ] && sig=${rest[2]}
    [ -n "$when" ] && at_boundary "${TINK_LAB_VM:?a kill --when needs TINK_LAB_VM, the machine to watch}"
    kill_proc "${rest[0]:?kill needs a process}" "$sig"
    ;;
  stop)
    tools
    stop_proc "${1:?stop needs a process}" || die "$1 is not running"
    ;;
  start)
    tools
    start_proc "${1:?start needs a process}"
    ;;
  disk)
    tools
    disk_cmd "$@"
    ;;
  efi)
    tools
    need_vm "${1:?efi needs a machine}"
    case ${2:-show} in
      show) efi "$1" ;;
      next | order | entry | delete | fill | unfill)
        # The variable store is QEMU's while it runs; a write needs the machine off.
        running_vm "$1" && die "power $1 off before changing its EFI variables"
        case $2 in
          next) out=$(efi "$1" --boot-next "${3:?efi next needs an entry}") ;;
          order) out=$(efi "$1" --boot-order "${3:?efi order needs entries}") ;;
          entry) out=$(efi "$1" --entry "${3:?efi entry needs N DESC PARTUUID FILE}" "${4:?}" "${5:?}" "${6:?}") ;;
          delete) out=$(efi "$1" --delete "${3:?efi delete needs an entry}") ;;
          fill) out=$(efi "$1" --fill "${3:-4096}") ;;
          unfill) out=$(efi "$1" --unfill) ;;
        esac
        event event=efi vm="$1" action="$2" "result=$out"
        ;;
      *) die "efi: show, next ENTRY|Pxe|Hdd, order ENTRY,..., entry N DESC PARTUUID FILE, delete N, fill [FREE] or unfill" ;;
    esac
    ;;
  registry)
    tools
    parse_when "$@"
    [ -n "$when" ] && at_boundary "${TINK_LAB_VM:?a registry --when needs TINK_LAB_VM, the machine to watch}"
    registry_cmd "${rest[@]}"
    ;;
  template)
    tools
    template_cmd "$@"
    ;;
  slow-installer)
    tools
    slow_installer "$@"
    ;;
  tools-image)
    tools
    tools_image "$@"
    ;;
  ubuntu-installer)
    tools
    ubuntu_installer
    ;;
  fleetd)
    tools
    case ${1:-} in
      start) fleetd_start "${@:2}" ;;
      stop)
        # A start right after must find the ports free.
        for p in fleetd netbox; do
          pid=$(pidof_ "$p")
          stop_proc "$p" || true
          end=$((SECONDS + 15))
          while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
        done
        ;;
      restart)
        parse_when "${@:2}"
        [ -n "$when" ] && at_boundary "${TINK_LAB_VM:?a fleetd restart --when needs TINK_LAB_VM, the machine to watch}"
        fleetd_restart "${rest[@]}"
        ;;
      build) fleetd_build ;;
      hold) fleetd_hold "${@:2}" ;;
      run)
        alive fleetd && die "fleetd runs"
        fleetd_run
        event event=start proc=fleetd pid="$(pidof_ fleetd)"
        ;;
      *) die "fleetd: start NAME... [--template T] [--interval DUR] [--status S] [--installer IMAGE], restart [--when C] [--down S] [--kill], hold REGEX|release, run, stop or build" ;;
    esac
    ;;
  host-restart)
    tools
    parse_when "$@"
    [ -n "$when" ] && at_boundary "${TINK_LAB_VM:?a host-restart --when needs TINK_LAB_VM, the machine to watch}"
    host_restart "${rest[0]:-0}"
    ;;
  netbox)
    tools
    netbox_cmd "$@"
    ;;
  webhook)
    tools
    webhook "$@"
    ;;
  config)
    tools
    config_cmd "$@"
    ;;
  config-net)
    tools
    parse_when "$@"
    at_boundary "${rest[0]:?config-net needs a machine}"
    config_net "${rest[@]}"
    ;;
  talos-boot)
    tools
    talos_boot "$@"
    ;;
  bmc)
    bmc_cmd "$@"
    ;;
  hookos-docker)
    tools
    name=${1:?hookos-docker needs a machine}
    shift
    [ $# -gt 0 ] || die "hookos-docker needs docker's arguments"
    rc=0
    out=$(console "$name" 60 "nerdctl -n services.linuxkit exec hook-docker docker $*") || rc=$?
    event event=hookos-docker vm="$name" "args=$*" status="$rc" output="$out"
    exit "$rc"
    ;;
  observe)
    tools
    with=true
    [ "${2:-}" = --no-console ] && with=false
    observe "${1:?observe needs a machine}" "$with"
    ;;
  *)
    sed -n '2,60p' "$0" >&2
    exit 2
    ;;
esac
