#!/usr/bin/env bash
# Boots the Asterisk the PBX image ships against each site's rendered config,
# with no route off the machine, and fails on what a PBX change must never
# break:
#
#   1. the Asterisk is the one nix/images/asterisk.nix builds, at the version
#      the Deployment's image tag pins;
#   2. the config renders the way the pod renders it — the overlay's own
#      render-config script over its own mounts, with a dummy for every PBX_*
#      value the pod's env provides, and again with every optional secret
#      dropped, since a 1Password item that does not exist yet must still
#      boot;
#   3. every PJSIP object the config declares loads, the modules a call needs
#      run and are not noloaded, nothing logs an error against a shipped
#      config file, and the dialplan reloads clean;
#   4. every handset line still sends 911, 933, ten and eleven digits, *97 and
#      0 through the `_[*0-9]!` pattern to its own voip.ms trunk, nothing
#      else rings a line HANDSET does not name, every exact code beside that
#      pattern is a star code into [toybox], and on folly a 911 sets
#      GLOBAL(LAST911);
#   5. nothing reachable from a context an inbound call starts in dials a
#      trunk, runs a shell, spies, or grants a transfer (pbx-inbound-walk.awk);
#   6. a site with [pbx-event] logs the line Grafana and the smiirl parse;
#   7. on folly, line 1's trunk is never screened, an open line, a contact and
#      a 911 callback ring unanswered, a stranger on a screened line hears the
#      press-5 prompt, a caller who pressed 5 rings the handset as [5] with the
#      Human ring, a caller who did not is held in a spam sink with the
#      ten-minute cap and its hangup handler, and every prompt the dialplan
#      plays is in the ConfigMap mounted for it.
#
# Usage: pbx-check.sh [site...]. The sites default to every
# clusters/<site>/apps/pbx. PBX_CHECK_KEEP=1 keeps the work directory.
#
# The rendered config reaches no one. Every SIP and HTTP host is rewritten to
# 127.0.0.1 and asserted before boot, and Asterisk runs in a network namespace
# that has only loopback. A workstation on folly's network shares its public
# address, and a REGISTER from there with a dummy password can get that
# address blocked by voip.ms, which takes every line down with it, 911
# included. Where an unprivileged namespace (`unshare -rn`) is unavailable the
# check refuses to boot, unless PBX_CHECK_HOST_NETWORK=1 accepts the rewrite
# and its assertion as the only guard. Asterisk binds loopback in both cases.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
WALKER="$ROOT/.github/scripts/pbx-inbound-walk.awk"

SYSTEM=x86_64-linux
HANDSET_CONTEXT=from-handset
HANDSET_PATTERN='_[*0-9]!'
# Each handset line must send every one of these through HANDSET_PATTERN,
# unchanged, to Dial(PJSIP/<number>@<its TRUNK>,60).
GOLDEN_NUMBERS=(911 933 6135550123 16135550123 '*97' 0)
REQUIRED_MODULES=(
  res_pjsip.so chan_pjsip.so res_pjsip_session.so res_pjsip_sdp_rtp.so
  res_pjsip_outbound_registration.so res_pjsip_endpoint_identifier_user.so
  res_pjsip_outbound_authenticator_digest.so res_pjsip_registrar.so
  res_srtp.so res_rtp_asterisk.so
  pbx_config.so app_dial.so app_stack.so res_prometheus.so
  codec_g722.so codec_ulaw.so
  app_read.so app_playback.so app_waitforsilence.so res_musiconhold.so
  func_groupcount.so func_timeout.so app_exec.so func_logic.so func_strings.so
)
# A second dial tone and a shell; modules.conf refuses them on every site.
FORBIDDEN_MODULES=(app_disa.so app_system.so func_shell.so)

WORK=""
ASTERISK_PID=""
SITE_FAILURES=0

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() {
  printf 'pbx-check: %s\n' "$*" >&2
  exit 1
}
fail() {
  SITE_FAILURES=$((SITE_FAILURES + 1))
  printf 'FAIL: %s\n' "$1" >&2
  if (($# > 1)); then printf '%s\n' "${@:2}" | sed 's/^/    /' >&2; fi
}

cleanup() {
  stop_asterisk
  if [[ -n $WORK && ${PBX_CHECK_KEEP:-} != 1 ]]; then
    rm -rf "$WORK"
  elif [[ -n $WORK ]]; then
    say "kept $WORK"
  fi
}

ast() { timeout 30 "$ASTERISK" -C "$ETC/asterisk.conf" -rx "$1"; }

stop_asterisk() {
  [[ -n $ASTERISK_PID ]] || return 0
  ast 'core stop now' >/dev/null 2>&1 || true
  local i
  for ((i = 0; i < 50; i++)); do
    kill -0 "$ASTERISK_PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$ASTERISK_PID" 2>/dev/null || true
  wait "$ASTERISK_PID" 2>/dev/null || true
  ASTERISK_PID=""
}

nix_out() { nix build --no-link --print-out-paths ".#legacyPackages.$SYSTEM.$1^out"; }

resolve_toolchain() {
  [[ $(uname -m) == x86_64 ]] || die "the PBX image is $SYSTEM; run this on an x86_64 host"
  command -v nix >/dev/null || die "nix is required: this boots the Asterisk the image builds"
  local tool
  for tool in kubectl yq unshare timeout; do
    command -v "$tool" >/dev/null || die "$tool is required"
  done

  say "==> resolving the image's Asterisk from the flake"
  local pkg
  pkg=$(nix_out asterisk)
  ASTERISK="$pkg/bin/asterisk"
  ASTERISK_PKG="$pkg"
  CACERT_BUNDLE="$(nix_out cacert)/etc/ssl/certs/ca-bundle.crt"
  ENVSUBST_BIN="$(nix_out gettext)/bin"
  IP="$(nix_out iproute2)/bin/ip"

  # The image and this check share nixpkgs by construction; this proves it, so
  # a future image that pins its own Asterisk cannot leave the check behind.
  local image_drv asterisk_drv
  image_drv=$(nix eval --raw ".#packages.$SYSTEM.asterisk-image.drvPath")
  asterisk_drv=$(nix eval --raw ".#legacyPackages.$SYSTEM.asterisk.drvPath")
  if ! nix-store --query --requisites "$image_drv" | grep -xF "$asterisk_drv" >/dev/null; then
    die "asterisk-image ($image_drv) is not built from $asterisk_drv; point this check at the image's Asterisk"
  fi
  ASTERISK_VERSION=$("$ASTERISK" -V | awk '{print $2}')
  say "    Asterisk $ASTERISK_VERSION at $ASTERISK_PKG"
}

pick_isolation() {
  if unshare -rn true 2>/dev/null; then
    ISOLATION=netns
  elif [[ ${PBX_CHECK_HOST_NETWORK:-} == 1 ]]; then
    ISOLATION=host
    warn "no unprivileged network namespace; booting on the host network with only the loopback rewrite as the guard"
  else
    die "cannot create a network namespace with 'unshare -rn'. Allow unprivileged user namespaces (Ubuntu: sysctl kernel.apparmor_restrict_unprivileged_userns=0), or set PBX_CHECK_HOST_NETWORK=1 to rely on the loopback rewrite alone."
  fi
}

# --- render --------------------------------------------------------------

dummy_for() {
  case $1 in
    *_IP | *_SERVER | *_HOST | *_DOMAIN) echo 127.0.0.1 ;;
    *_DID | *_NUMBER) echo +15555550100 ;;
    *) echo pbx-check-dummy ;;
  esac
}

# The one document of kind $1 named $2 in the site's render.
doc() { KIND="$1" NAME="$2" yq 'select(.kind == strenv(KIND) and .metadata.name == strenv(NAME))' "$STREAM"; }

render() {
  local site=$1 mode=${2:-full} keys
  [[ $mode == full ]] && HAS_OPTIONAL=0
  STREAM="$SITE_DIR/kustomize.yaml"
  if ! kubectl kustomize "clusters/$site/apps/pbx" >"$STREAM" 2>"$SITE_DIR/kustomize.err"; then
    fail "kubectl kustomize clusters/$site/apps/pbx" "$(cat "$SITE_DIR/kustomize.err")"
    return 1
  fi

  # One document per file. A yq query over the multi-document stream pads its
  # output with a separator for every document that did not match.
  local pod="$SITE_DIR/pod.yaml" init="$SITE_DIR/render-config.yaml"
  yq 'select(.kind == "Deployment" and .metadata.name == "pbx") | .spec.template.spec' "$STREAM" >"$pod"
  yq '.initContainers[] | select(.name == "render-config")' "$pod" >"$init"
  if [[ ! -s $init ]]; then
    fail "the pbx Deployment has no render-config init container"
    return 1
  fi

  local tags tag
  tags=$(yq '(.initContainers[], .containers[]) | .image | select(test("/asterisk:"))' "$pod" | sort -u)
  for tag in $tags; do
    tag=${tag##*:}
    if [[ ${tag%%-*} != "$ASTERISK_VERSION" ]]; then
      fail "the Deployment runs asterisk:$tag, but the flake's Asterisk is $ASTERISK_VERSION"
    fi
  done
  [[ -n $tags ]] || fail "no container in the pbx Deployment runs the asterisk image"

  local command
  command=$(yq '.command | join(" ")' "$init")
  if [[ ! $command =~ ^/bin/bash\ (/[^ ]+)$ ]]; then
    fail "render-config runs '$command'; this check knows only '/bin/bash <script>'"
    return 1
  fi
  local script=${BASH_REMATCH[1]}

  # Every configMap the init container mounts, at its mount path under root/.
  local -a rewrites=()
  local mount volume cm key
  while IFS=$'\t' read -r mount volume; do
    [[ -n $mount ]] || continue
    mkdir -p "$SITE_DIR/root$mount"
    rewrites+=("$mount")
    cm=$(V="$volume" yq '.volumes[] | select(.name == strenv(V)) | .configMap.name // ""' "$pod")
    if [[ -n $cm ]]; then
      doc ConfigMap "$cm" >"$SITE_DIR/doc.yaml"
      while IFS= read -r key; do
        # yq ends every string with a newline of its own.
        K="$key" yq '.data[strenv(K)]' "$SITE_DIR/doc.yaml" | head -c -1 >"$SITE_DIR/root$mount/$key"
      done < <(yq '.data // {} | keys | .[]' "$SITE_DIR/doc.yaml")
      continue
    fi
    # An emptyDir is where render-config writes its output, not an input this
    # check populates. Anything else (a Secret, a projected volume) is an
    # input this check cannot model; leaving it an empty directory would let
    # render-config either fail confusingly or silently skip what it expected
    # there, so this fails loudly instead of skipping it.
    if [[ $(V="$volume" yq '.volumes[] | select(.name == strenv(V)) | has("emptyDir")' "$pod") == true ]]; then
      continue
    fi
    fail "render-config mounts $mount from volume '$volume', which is not a ConfigMap or emptyDir; this check cannot model it"
    return 1
  done < <(yq '.volumeMounts[] | [.mountPath, .name] | @tsv' "$init")

  ETC="$SITE_DIR/root/etc/asterisk"
  [[ -d $ETC ]] || {
    fail "render-config mounts nothing at /etc/asterisk"
    return 1
  }

  # The pod's env: envFrom in order, then env. A ConfigMap literal is used as
  # is unless Flux would have substituted it; a Secret key gets a dummy.
  local -A env=()
  local cm_name secret_name secret_optional k v
  while IFS=$'\t' read -r cm_name secret_name secret_optional; do
    if [[ $cm_name != - ]]; then
      doc ConfigMap "$cm_name" >"$SITE_DIR/doc.yaml"
      [[ -s $SITE_DIR/doc.yaml ]] || warn "$site: render-config reads ConfigMap $cm_name, which is not in the render"
      while IFS=$'\t' read -r k v; do
        [[ -n $k ]] || continue
        [[ $v == *"\${"* ]] && v=$(dummy_for "$k")
        env[$k]=$v
      done < <(yq '.data // {} | to_entries | .[] | [.key, .value] | @tsv' "$SITE_DIR/doc.yaml")
    elif [[ $secret_name != - ]]; then
      # Degraded mode models the item this Secret comes from not existing yet:
      # drop the whole source, not just its keys, the way ESO would.
      if [[ $mode == degraded && $secret_optional == true ]]; then continue; fi
      N="$secret_name" yq 'select(.kind == "ExternalSecret" and (.spec.target.name // .metadata.name) == strenv(N))' "$STREAM" >"$SITE_DIR/doc.yaml"
      if [[ -s $SITE_DIR/doc.yaml ]]; then
        if [[ $(yq '.spec | has("dataFrom")' "$SITE_DIR/doc.yaml") == true ]]; then
          fail "the ExternalSecret for $secret_name uses dataFrom; its keys cannot be known here"
        fi
        keys=$(yq '.spec.data[].secretKey' "$SITE_DIR/doc.yaml")
      else
        doc Secret "$secret_name" >"$SITE_DIR/doc.yaml"
        [[ -s $SITE_DIR/doc.yaml ]] || warn "$site: render-config reads Secret $secret_name, which nothing in the render creates"
        keys=$(yq '(.data // {}) + (.stringData // {}) | keys | .[]' "$SITE_DIR/doc.yaml")
      fi
      for k in $keys; do env[$k]=$(dummy_for "$k"); done
      [[ $mode == full && $secret_optional == true && -n $keys ]] && HAS_OPTIONAL=1
    fi
  done < <(yq '(.envFrom // [])[] | [(.configMapRef.name // "-"), (.secretRef.name // "-"), (.secretRef.optional // false)] | @tsv' "$init")
  while IFS=$'\t' read -r k v; do
    [[ -n $k ]] || continue
    env[$k]=${v:-$(dummy_for "$k")}
  done < <(yq '(.env // [])[] | [.name, (.value // "")] | @tsv' "$init")

  local -a sed_args=() assignments=()
  while IFS= read -r mount; do
    sed_args+=(-e "s#$mount#$SITE_DIR/root$mount#g")
  done < <(printf '%s\n' "${rewrites[@]}" | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-)
  sed "${sed_args[@]}" "$SITE_DIR/root$script" >"$SITE_DIR/render.sh"
  for k in "${!env[@]}"; do assignments+=("$k=${env[$k]}"); done

  if ! env -i PATH="$ENVSUBST_BIN:$PATH" "${assignments[@]}" bash "$SITE_DIR/render.sh" >"$SITE_DIR/render.log" 2>&1; then
    fail "render-config's script failed" "$(cat "$SITE_DIR/render.log")"
    return 1
  fi

  local unresolved
  unresolved=$(cd "$ETC" && awk '{ line = $0; gsub(/\\;/, "", line); sub(/;.*/, "", line) } line ~ /\$\{PBX_/ { print FILENAME ":" FNR ": " $0 }' ./*.conf)
  if [[ -n $unresolved ]]; then
    fail "a template names a PBX_* variable nothing in the pod's env provides; the pod would render it literally" "$unresolved"
  fi
  say "    rendered $(cd "$ETC" && echo *.conf)"
}

# --- localize: nothing in the rendered config may leave this machine -------

localize() {
  local f
  local conf="$ETC/asterisk.conf"
  awk -v etc="$ETC" -v lib="$ASTERISK_PKG/var/lib/asterisk" -v run="$SITE_DIR" '
    /^\[directories\]/ {
      print
      print "astetcdir => " etc
      print "astvarlibdir => " lib
      print "astdatadir => " lib
      print "astagidir => " lib "/agi-bin"
      print "astkeydir => " lib
      print "astdbdir => " run "/db"
      print "astlogdir => " run "/log"
      print "astspooldir => " run "/spool"
      print "astrundir => " run "/run"
      print "astcachedir => " run "/cache"
      skip = 1
      next
    }
    /^\[options\]/ {
      print
      # The pod seeds this from its NIC; the namespace has none.
      print "entityid = 02:00:00:00:00:01"
      skip = 0
      next
    }
    /^\[/ { skip = 0 }
    skip && /=/ { next }
    { print }
  ' "$conf" >"$conf.new"
  mv "$conf.new" "$conf"
  mkdir -p "$SITE_DIR"/{db,log,spool,run,cache}

  for f in "$ETC"/*.conf; do
    [[ $f == "$conf" ]] && continue
    sed -Ei \
      -e "s#/etc/asterisk#$ETC#g" \
      -e "s#^([[:space:]]*ca_list_file[[:space:]]*=[[:space:]]*).*#\\1$CACERT_BUNDLE#" \
      -e 's#(^|[^A-Za-z0-9.-])([A-Za-z0-9-]+\.)*(voip\.ms|elevenlabs\.io)([^A-Za-z0-9.-]|$)#\1127.0.0.1\4#g' \
      -e 's#(^|[^A-Za-z])(sips?:)([^@;:>[:space:]\\]+@)?(\[[^]]*\]|[^;:>[:space:]\\/,)]+)#\1\2\3127.0.0.1#g' \
      -e 's#(https?://)([^/@[:space:]]+@)?(\[[^]]*\]|[^/:[:space:],)"]+)#\1\2127.0.0.1#g' \
      -e 's#^([[:space:]]*(from_domain|stunaddr|turnaddr)[[:space:]]*=[[:space:]]*).+#\1127.0.0.1#' \
      -e 's#^([[:space:]]*bind[[:space:]]*=[[:space:]]*)(\[[^]]*\]|[^:[:space:]]+)#\1127.0.0.1#' \
      -e 's#^([[:space:]]*(tls)?bindaddr[[:space:]]*=[[:space:]]*).*#\1127.0.0.1#' \
      "$f"
  done

  [[ ! -e $ETC/pbx-check.conf ]] || {
    fail "the site ships a pbx-check.conf, which this check writes its own test contexts to"
    return 1
  }
  : >"$ETC/pbx-check.conf"
  printf '\n#include "pbx-check.conf"\n' >>"$ETC/extensions.conf"

  assert_loopback
}

# A noload here is silent: the module just is not there, and nothing a boot
# logs counts it. res_pjsip*/chan_pjsip* are how a handset registers, gets
# identified and answers voip.ms's digest challenge, so any of them missing
# breaks a real call while every check here keeps passing.
check_no_pjsip_noload() {
  local offenders
  offenders=$(awk '
    /^[[:space:]]*noload[[:space:]]*=/ {
      mod = $0
      sub(/^[[:space:]]*noload[[:space:]]*=[[:space:]]*/, "", mod)
      sub(/[[:space:]]*;.*/, "", mod)
      if (mod ~ /^(res_pjsip|chan_pjsip)/) print FILENAME ":" FNR ": " $0
    }
  ' "$ETC/modules.conf" 2>/dev/null)
  [[ -z $offenders ]] || fail "modules.conf noloads a PJSIP module a handset call needs" "${offenders//$ETC\//}"
}

# Every SIP and HTTP URI and every host-bearing key must name loopback, or
# nothing boots.
assert_loopback() {
  local offenders
  offenders=$(awk '
    function host_ok(h) { return h == "127.0.0.1" || h == "localhost" || h == "[::1]" }
    {
      line = $0
      gsub(/\\;/, "\001", line)
      sub(/;.*/, "", line)
      gsub(/\001/, ";", line)
      bad = ""
      rest = line
      while (match(rest, /(^|[^A-Za-z])sips?:/)) {
        rest = substr(rest, RSTART + RLENGTH)
        uri = rest
        sub(/^[^@;:>[:space:]\\]+@/, "", uri)
        if (match(uri, /^\[[^]]*\]/) || match(uri, /^[^;:>[:space:]\\\/,)]+/)) h = substr(uri, 1, RLENGTH)
        else h = ""
        if (!host_ok(h)) bad = bad " " h
      }
      rest = line
      while (match(rest, /https?:\/\//)) {
        rest = substr(rest, RSTART + RLENGTH)
        uri = rest
        sub(/^[^\/@[:space:]]+@/, "", uri)
        if (match(uri, /^\[[^]]*\]/) || match(uri, /^[^\/:[:space:],)"]+/)) h = substr(uri, 1, RLENGTH)
        else h = ""
        if (!host_ok(h)) bad = bad " " h
      }
      if (match(line, /^[[:space:]]*(server_uri|client_uri|contact|outbound_proxy|outbound_registration_proxy)[[:space:]]*=>?[[:space:]]*[^[:space:]]/) && line !~ /sips?:/)
        bad = bad " (no sip: URI)"
      if (match(line, /^[[:space:]]*(from_domain|stunaddr|turnaddr)[[:space:]]*=>?[[:space:]]*/)) {
        v = substr(line, RLENGTH + 1)
        sub(/[[:space:]]+$/, "", v)
        sub(/:[0-9]+$/, "", v)
        if (v != "" && !host_ok(v)) bad = bad " " v
      }
      if (line ~ /(voip\.ms|elevenlabs\.io)/) bad = bad " (carrier hostname)"
      if (bad != "") printf "%s:%d:%s <-%s\n", FILENAME, FNR, $0, bad
    }
  ' "$ETC"/*.conf)
  if [[ -n $offenders ]]; then
    fail "a host in the rendered config is not loopback; refusing to boot" "${offenders//$ETC\//}"
    return 1
  fi
}

# --- boot ------------------------------------------------------------------

boot() {
  local log="$SITE_DIR/asterisk.log" ctl="$SITE_DIR/run/asterisk.ctl" i
  # A Unix socket path over 108 bytes is silently truncated.
  ((${#ctl} < 100)) || die "socket path too long ($ctl); set TMPDIR to a shorter directory"
  case $ISOLATION in
    netns)
      # Loopback up, and proof there is no route anywhere else, before exec.
      # shellcheck disable=SC2016 # expanded by the inner shell
      unshare -rn -- bash -c '
        "$1" link set lo up || exit 1
        if "$1" route get 192.0.2.1 >/dev/null 2>&1; then
          echo "pbx-check: the namespace has a route off this machine; refusing to boot" >&2
          exit 1
        fi
        exec "$2" -f -C "$3"
      ' _ "$IP" "$ASTERISK" "$ETC/asterisk.conf" </dev/null >"$log" 2>&1 &
      ;;
    host) "$ASTERISK" -f -C "$ETC/asterisk.conf" </dev/null >"$log" 2>&1 & ;;
  esac
  ASTERISK_PID=$!
  for ((i = 0; i < 300; i++)); do
    [[ -S $ctl ]] && break
    if ! kill -0 "$ASTERISK_PID" 2>/dev/null; then
      ASTERISK_PID=""
      fail "Asterisk exited while booting" "$(tail -n 40 "$log")"
      return 1
    fi
    sleep 0.1
  done
  if ! ast 'core waitfullybooted' >/dev/null; then
    fail "Asterisk did not finish booting" "$(tail -n 40 "$log")"
    return 1
  fi
}

# WARNING and ERROR lines from the given log text that are about this config.
# A line qualifies when it names a shipped file, or when it comes from the
# config, dialplan, PJSIP or media code and names no other module's .conf.
# Modules nothing configures log the rest on every boot. $2 narrows the
# sources.
config_errors() {
  local text=$1 sources=${2:-'config|config_options|sorcery|res_sorcery_config|pbx|pbx_config|chan_pjsip|res_pjsip[a-z_]*|res_pjsip/[a-z_]+|res_rtp_asterisk|rtp_engine|res_srtp|res_prometheus|http|logger'}
  local shipped
  shipped=$(cd "$ETC" && printf '%s\n' *.conf | sed 's/\./\\./g' | paste -sd'|')
  # Passed through the environment, because awk -v would eat the regex escapes.
  SHIPPED="^($shipped)$" SOURCES="^($sources)\\.c$" awk '
    !/(WARNING|ERROR)\[[0-9]+\]/ { next }
    {
      named = 0; foreign = 0
      rest = $0
      while (match(rest, /[A-Za-z0-9_.-]+\.conf/)) {
        f = substr(rest, RSTART, RLENGTH)
        if (f ~ ENVIRON["SHIPPED"]) named = 1; else foreign = 1
        rest = substr(rest, RSTART + RLENGTH)
      }
      src = $0
      sub(/^.*(WARNING|ERROR)\[[0-9]+\]: /, "", src)
      sub(/:[0-9]+ .*/, "", src)
      if (named || (src ~ ENVIRON["SOURCES"] && !foreign)) print
    }
  ' <<<"$text"
}

check_boot_log() {
  local log="$SITE_DIR/asterisk.log" boot_text errors line mod base
  boot_text=$(sed '/^Asterisk Ready\./q' "$log")
  errors=$(config_errors "$boot_text")
  # A module that declines while its own config file ships is broken, not idle.
  while IFS= read -r line; do
    mod=${line%% declined to load*}
    mod=${mod##* }
    base=${mod#res_}
    base=${base#app_}
    base=${base#chan_}
    base=${base#pbx_}
    base=${base#func_}
    if [[ -f $ETC/$mod.conf || -f $ETC/$base.conf ]]; then errors+=$'\n'"$line"; fi
  done < <(grep -E ' [a-z0-9_]+ declined to load\.' <<<"$boot_text" || true)
  errors=$(sed '/^$/d' <<<"$errors")
  if [[ -n $errors ]]; then
    fail "Asterisk logged errors against this config while booting" "$errors"
  fi

  local missing=()
  for mod in "${REQUIRED_MODULES[@]}"; do
    ast "module show like $mod" | grep -E "^${mod}[[:space:]].*[[:space:]]Running[[:space:]]" >/dev/null || missing+=("$mod")
  done
  if ((${#missing[@]})); then fail "required modules are not running" "${missing[@]}"; fi

  local loaded=()
  for mod in "${FORBIDDEN_MODULES[@]}"; do
    if ast "module show like $mod" | grep -E "^${mod}[[:space:]]" >/dev/null; then loaded+=("$mod"); fi
  done
  if ((${#loaded[@]})); then fail "modules.conf must refuse these, and they loaded" "${loaded[@]}"; fi
}

# --- PJSIP: declared vs loaded --------------------------------------------

flatten() {
  local file=$1 line target
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ ^[[:space:]]*#(try)?include[[:space:]]+\"?([^\"[:space:]]+) ]]; then
      target=${BASH_REMATCH[2]}
      [[ $target == /* ]] || target="$ETC/$target"
      if [[ -f $target ]]; then flatten "$target"; fi
    else
      printf '%s\n' "$line"
    fi
  done <"$file"
}

# "type<TAB>name" for every non-template section, its type inherited from its
# templates when it has none of its own.
declared_objects() {
  flatten "$ETC/pjsip.conf" | awk '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    function resolve(i,   k, m, p) {
      if (type[i] != "") return type[i]
      m = split(parents[i], p, " ")
      for (k = 1; k <= m; k++) if ((p[k] in byname) && resolve(byname[p[k]]) != "") return resolve(byname[p[k]])
      return ""
    }
    {
      line = $0
      gsub(/\\;/, "\001", line)
      sub(/;.*/, "", line)
      line = trim(line)
      if (line == "") next
      if (substr(line, 1, 1) == "[") {
        n++
        name[n] = line
        sub(/^\[/, "", name[n])
        sub(/\].*/, "", name[n])
        opts = ""
        if (match(line, /\]\(.*\)$/)) opts = substr(line, RSTART + 2, RLENGTH - 3)
        m = split(opts, o, ",")
        for (k = 1; k <= m; k++) {
          o[k] = trim(o[k])
          if (o[k] == "!") tmpl[n] = 1
          else if (o[k] != "") parents[n] = parents[n] " " o[k]
        }
        byname[name[n]] = n
        next
      }
      if (n && line ~ /^type[[:space:]]*=/) {
        t = line
        sub(/^type[[:space:]]*=>?[[:space:]]*/, "", t)
        type[n] = t
      }
    }
    END { for (i = 1; i <= n; i++) if (!tmpl[i]) print resolve(i) "\t" name[i] }
  ' | sort -u
}

loaded_objects() {
  {
    ast 'pjsip show endpoints' | awk '$1 == "Endpoint:" && $2 !~ /^</ { split($2, a, "/"); print "endpoint\t" a[1] }'
    ast 'pjsip show aors' | awk '$1 == "Aor:" && $2 !~ /^</ { print "aor\t" $2 }'
    ast 'pjsip show auths' | awk '$1 == "Auth:" && $2 !~ /^</ { split($2, a, "/"); print "auth\t" a[1] }'
    ast 'pjsip show transports' | awk '$1 == "Transport:" && $2 !~ /^</ { print "transport\t" $2 }'
    ast 'pjsip show registrations' | awk '$1 ~ /^[^<].*\/sips?:/ { split($1, a, "/"); print "registration\t" a[1] }'
  } | sort -u
}

check_pjsip_objects() {
  local declared loaded missing
  declared=$(declared_objects | grep -E '^(endpoint|aor|auth|transport|registration)'$'\t' || true)
  loaded=$(loaded_objects)
  missing=$(comm -23 <(printf '%s\n' "$declared") <(printf '%s\n' "$loaded"))
  if [[ -n $missing ]]; then
    fail "pjsip.conf declares objects Asterisk did not load (type, name)" "$missing"
  fi
  ENDPOINTS=$(awk -F'\t' '$1 == "endpoint" { print $2 }' <<<"$declared")
  [[ -n $missing ]] || say "    all $(wc -l <<<"$declared") declared PJSIP objects loaded, $(wc -w <<<"$ENDPOINTS") of them endpoints"
}

# --- 911 through the handset pattern -------------------------------------

endpoint_param() { awk -v key="$2" '$1 == key && $2 == ":" { $1 = ""; $2 = ""; sub(/^ +/, ""); print; exit }' <<<"$1"; }

check_reload_and_handsets() {
  local site=$1 ep show ctx trunk handset
  local -a lines=() trunks=() roots=(from-voipms) screened=()
  local -A shows=()
  for ep in $ENDPOINTS; do
    show=$(ast "pjsip show endpoint $ep")
    shows[$ep]=$show
    ctx=$(endpoint_param "$show" context)
    if [[ $ctx == "$HANDSET_CONTEXT" ]]; then
      trunk=$(endpoint_param "$show" TRUNK)
      lines+=("$ep")
      trunks+=("$trunk")
      if [[ $trunk != vms-* ]] || ! grep -qxF "$trunk" <<<"$ENDPOINTS"; then
        fail "handset line $ep dials out on TRUNK='$trunk', which is not a declared vms-* trunk"
      fi
    elif [[ -n $ctx && $ctx != from-voipms ]]; then
      roots+=("$ctx")
    fi
    if [[ $ctx == from-voipms && $(endpoint_param "$show" SCREEN) == yes ]]; then screened+=("$ep"); fi
  done
  INBOUND_ROOTS="${roots[*]}"

  # The reverse of the TRUNK check above: every endpoint that is not itself a
  # handset line must ring one of the declared lines, or ring none. A caller's
  # own DID set as HANDSET would let that caller originate an outbound call on
  # whatever endpoint names it — toll fraud a golden-number Dial never sees,
  # since it originates on the handset side, not the trunk side.
  local lines_nl
  lines_nl=$(printf '%s\n' "${lines[@]}")
  for ep in $ENDPOINTS; do
    grep -qxF "$ep" <<<"$lines_nl" && continue
    handset=$(endpoint_param "${shows[$ep]}" HANDSET)
    if [[ -n $handset ]] && ! grep -qxF "$handset" <<<"$lines_nl"; then
      fail "endpoint $ep rings HANDSET='$handset', which is not a declared handset line"
    fi
  done

  local i
  : >"$ETC/pbx-check.conf"
  for i in "${!lines[@]}"; do
    # shellcheck disable=SC2016 # ${EXTEN} is Asterisk's
    printf '[pbx-check-%s]\nexten => %s,1,Set(TRUNK=%s)\n same => n,Goto(%s,${EXTEN},1)\n\n' \
      "${lines[i]}" "$HANDSET_PATTERN" "${trunks[i]}" "$HANDSET_CONTEXT" >>"$ETC/pbx-check.conf"
    # The handset dials 911 on line 1, so 911 calls back on line 1's trunk.
    if [[ ${lines[i]} == line1 ]] && printf '%s\n' "${screened[@]}" | grep -qxF "${trunks[i]}"; then
      fail "${trunks[i]} sets SCREEN=yes, but line1 dials 911 on it, so a callback from 911 would be screened"
    fi
  done
  if [[ $site == folly ]]; then
    printf '%s\n' "${INBOUND_PROBE_CONTEXT[@]}" '' >>"$ETC/pbx-check.conf"
  fi
  if has_context pbx-event; then
    printf '%s\n' '[pbx-check-event]' \
      'exten => s,1,Set(HANDSET=line4)' \
      ' same => n,Set(CALLERID(num)=+1 (613) 555-0123)' \
      " same => n,Gosub(pbx-event,s,1($EVENT_PROBE_ARGS))" \
      ' same => n,Hangup()' '' >>"$ETC/pbx-check.conf"
  fi

  local log="$SITE_DIR/asterisk.log" offset reply errors
  offset=$(wc -c <"$log")
  reply=$(ast 'dialplan reload')
  sleep 0.5
  errors=$(config_errors "$(tail -c +"$((offset + 1))" "$log")" 'config|pbx|pbx_config')
  if [[ $reply != *"Dialplan reloaded"* || -n $errors ]]; then
    fail "the dialplan did not reload clean" "$reply" "$errors"
  fi

  # folly is the office phone's site, so it must keep a handset context; any
  # site that has one must have a line in it that loaded.
  if ((${#lines[@]} == 0)); then
    if [[ $site == folly ]] || ast "dialplan show $HANDSET_CONTEXT" | grep -F "[ Context '$HANDSET_CONTEXT'" >/dev/null; then
      fail "no loaded endpoint lands in [$HANDSET_CONTEXT], so nothing proves where 911 goes"
    else
      say "    no [$HANDSET_CONTEXT]; 911 routing does not apply"
    fi
    return 0
  fi

  local num owner
  for num in "${GOLDEN_NUMBERS[@]}"; do
    owner=$(ast "dialplan show $num@$HANDSET_CONTEXT" | awk -v c="[ Context '$HANDSET_CONTEXT'" '
      index($0, c) == 1 { inside = 1; next }
      /^\[ / { inside = 0 }
      inside && match($0, /^  '\''[^'\'']*'\''/) { print substr($0, RSTART + 3, RLENGTH - 4); exit }
    ')
    if [[ $owner != "$HANDSET_PATTERN" ]]; then
      fail "$num in [$HANDSET_CONTEXT] matches '$owner' first, not $HANDSET_PATTERN"
    fi
    for i in "${!lines[@]}"; do
      ast "channel originate Local/$num@pbx-check-${lines[i]}/n application Wait 1" >/dev/null
    done
  done
  # Originate returns before its channel exists, so wait for the Dials
  # themselves. A broken route never produces its Dial and runs out the clock.
  local expected=$((${#lines[@]} * ${#GOLDEN_NUMBERS[@]}))
  for ((i = 0; i < 100; i++)); do
    (($(grep -cF '@pbx-check-' <(grep -F '] Dial("Local/' "$log")) >= expected)) && break
    sleep 0.2
  done
  ast 'channel request hangup all' >/dev/null || true

  local -a diffs=()
  local got want
  for i in "${!lines[@]}"; do
    for num in "${GOLDEN_NUMBERS[@]}"; do
      want="PJSIP/$num@${trunks[i]},60"
      got=$(awk -v step="Executing [$num@$HANDSET_CONTEXT:" -v chan="Dial(\"Local/$num@pbx-check-${lines[i]}-" '
        index($0, step) && index($0, chan) { s = $0; sub(/.*", "/, "", s); sub(/"\).*/, "", s); print s; exit }
      ' "$log")
      [[ $got == "$want" ]] || diffs+=("${lines[i]} $num: want Dial($want), got ${got:+Dial($got)}${got:-no Dial}")
    done
  done
  if ((${#diffs[@]})); then
    fail "handset calls no longer reach their trunk through $HANDSET_PATTERN" "${diffs[@]}"
  else
    say "    ${#lines[@]} handset line(s) x ${#GOLDEN_NUMBERS[@]} numbers reach Dial(PJSIP/<number>@<trunk>,60)"
  fi

  if [[ $site == folly ]] && ! ast 'dialplan show globals' | grep -E '^[[:space:]]*LAST911=[0-9]+[[:space:]]*$' >/dev/null; then
    fail "a 911 from the handset did not set GLOBAL(LAST911), so a callback from 911 would be screened"
  fi
  check_handset_codes "${lines[0]}"
}

# Every exact extension in the handset context is a star code into [toybox]:
# a code that starts with a digit would take a number away from the trunk.
check_handset_codes() {
  local line=$1 code log="$SITE_DIR/asterisk.log" i
  local -a codes=() wrong=()
  mapfile -t codes < <(ast "dialplan show $HANDSET_CONTEXT" | awk -v c="[ Context '$HANDSET_CONTEXT'" -v p="$HANDSET_PATTERN" '
    index($0, c) == 1 { inside = 1; next }
    /^\[ / { inside = 0 }
    inside && match($0, /^  '\''[^'\'']*'\''/) { e = substr($0, RSTART + 3, RLENGTH - 4); if (e != p) print e }
  ')
  ((${#codes[@]})) || return 0
  for code in "${codes[@]}"; do
    [[ $code == \** ]] || wrong+=("$code does not start with *")
    ast "channel originate Local/$code@pbx-check-$line/n application Wait 1" >/dev/null
  done
  for code in "${codes[@]}"; do
    for ((i = 0; i < 50; i++)); do
      grep -F "(\"Local/$code@pbx-check-$line-" "$log" | grep -F '@toybox:1] ' >/dev/null && break
      sleep 0.1
    done
    ((i < 50)) || wrong+=("$code never reached [toybox]")
  done
  ast 'channel request hangup all' >/dev/null || true
  if ((${#wrong[@]})); then
    fail "handset codes must be star codes that land in [toybox]" "${wrong[@]}"
  else
    say "    ${#codes[@]} handset codes reach [toybox], none of them a number"
  fi
}

# --- the pbx-event log contract ----------------------------------------------

has_context() { grep -qxF "[$1]" "$ETC"/*.conf; }

# Grafana and the smiirl parse this line out of VictoriaLogs.
EVENT_PROBE_ARGS='screened,secs=3,sink=queue'
EVENT_PROBE_WANT='pbx-event kind=screened line=line4 caller=16135550123 secs=3 sink=queue'

check_events() {
  has_context pbx-event || return 0
  local log="$SITE_DIR/asterisk.log" got="" offset i
  offset=$(wc -c <"$log")
  ast 'channel originate Local/s@pbx-check-event/n application Wait 1' >/dev/null
  for ((i = 0; i < 50; i++)); do
    got=$(tail -c +"$((offset + 1))" "$log" | grep -F '] NOTICE[' | grep -oE 'pbx-event kind=.*$' | head -n 1 || true)
    [[ -n $got ]] && break
    sleep 0.1
  done
  if [[ $got == "$EVENT_PROBE_WANT" ]]; then
    say "    the pbx-event helper logs the contract line"
  else
    fail "the pbx-event helper broke the log contract" "want: $EVENT_PROBE_WANT" "got:  ${got:-nothing}"
  fi
}

# --- inbound ---------------------------------------------------------------

# folly's inbound routes, each driven by a caller the check fakes: an open line
# rings unanswered, a screened line rings unanswered for a contact or within an
# hour of a 911, and answers anyone else with the press-5 prompt. `human` and
# `sink` enter where a Read verdict would send the caller, since no probe can
# press a digit: a 5 rings the handset as [5], anything else is held in [spam].
# shellcheck disable=SC2016 # ${EPOCH} is Asterisk's
INBOUND_PROBE_CONTEXT=(
  '[pbx-check-inbound]'
  'exten => open,1,Set(HANDSET=line1)'
  ' same => n,Set(CALLERID(num)=6135550101)'
  ' same => n,Goto(from-voipms,s,1)'
  'exten => callback,1,Set(HANDSET=line4)'
  ' same => n,Set(SCREEN=yes)'
  ' same => n,Set(GLOBAL(LAST911)=${EPOCH})'
  ' same => n,Set(CALLERID(num)=6135550102)'
  ' same => n,Goto(from-voipms,s,1)'
  'exten => contact,1,Set(HANDSET=line4)'
  ' same => n,Set(SCREEN=yes)'
  ' same => n,Set(GLOBAL(LAST911)=)'
  ' same => n,Set(GLOBAL(CONTACT_6135550104)=Pbx Check)'
  ' same => n,Set(CALLERID(num)=+1 613 555 0104)'
  ' same => n,Goto(from-voipms,s,1)'
  'exten => stranger,1,Set(HANDSET=line4)'
  ' same => n,Set(SCREEN=yes)'
  ' same => n,Set(GLOBAL(LAST911)=)'
  ' same => n,Set(CALLERID(num)=6135550103)'
  ' same => n,Goto(from-voipms,s,1)'
  'exten => human,1,Set(HANDSET=line4)'
  ' same => n,Set(CALLERID(num)=6135550105)'
  ' same => n,Set(CALLER=6135550105)'
  ' same => n,Goto(from-voipms,human,1)'
  'exten => sink,1,Set(HANDSET=line4)'
  ' same => n,Set(CALLERID(num)=6135550106)'
  ' same => n,Answer()'
  ' same => n,Goto(spam,s,1)'
)

# Places probe $1 and fails if its Executing lines hold $2, or miss any of the
# rest. The last is the route's final step, so it is the one waited for.
expect_route() {
  local name=$1 refuse=$2 seen="" want i
  shift 2
  ast "channel originate Local/$name@pbx-check-inbound/n application Wait 1" >/dev/null
  for ((i = 0; i < 50; i++)); do
    seen=$(grep -F "(\"Local/$name@pbx-check-inbound-" "$SITE_DIR/asterisk.log" || true)
    [[ $seen == *"${!#}"* ]] && break
    sleep 0.1
  done
  for want in "$@"; do
    [[ $seen == *"$want"* ]] || fail "inbound probe '$name' never ran $want"
  done
  if [[ $seen == *"$refuse"* ]]; then fail "inbound probe '$name' ran $refuse"; fi
}

check_inbound_routes() {
  [[ $1 == folly ]] || return 0
  local before=$SITE_FAILURES answer='] Answer("'
  expect_route open "$answer" '"PJSIP/line1,25,b(handset-leg^s^1())"'
  expect_route callback "$answer" '"PJSIP/line4,25,b(handset-leg^s^1())"'
  expect_route contact "$answer" \
    '"NOTICE,pbx-event kind=contact line=line4 caller=16135550104"' \
    '"CALLERID(name)=[OK] Pbx Check"' \
    '"PJSIP/line4,25,b(handset-leg^s^1(Friend))"'
  expect_route stranger '"PJSIP/line4,' "$answer" '"DIGIT,/var/lib/pbx-sounds/captcha-greeting,1,,1,6"'
  expect_route human "$answer" \
    '"NOTICE,pbx-event kind=captcha-pass line=line4 caller=6135550105"' \
    '"CALLERID(name)=[5] 6135550105"' \
    '"PJSIP/line4,25,mb(handset-leg^s^1(Human))"'
  # A sink never dials anything.
  expect_route sink '"PJSIP/' '"TIMEOUT(absolute)=600"' '"GROUP()=spam"' \
    '"CHANNEL(hangup_handler_push)=spam-held,s,1"'
  ((SITE_FAILURES > before)) || say "    inbound probes: open line, 911 callback and contact ring; a stranger gets press 5, a 5 rings as [5], the rest are held"
}

# Every prompt the dialplan plays from a ConfigMap the asterisk container
# mounts must be a key of that ConfigMap. Playback takes no extension.
check_sounds() {
  local pod="$SITE_DIR/pod.yaml" mount volume cm ref key refs
  local -a missing=()
  while IFS=$'\t' read -r mount volume; do
    cm=$(V="$volume" yq '.volumes[] | select(.name == strenv(V)) | .configMap.name // ""' "$pod")
    [[ -n $cm ]] || continue
    doc ConfigMap "$cm" >"$SITE_DIR/sounds.yaml"
    refs=$(grep -ohE "$mount/[^,)\"[:space:]]+" "$ETC"/*.conf | sort -u || true)
    for ref in $refs; do
      key=${ref#"$mount"/}
      K="$key" yq -e '(.binaryData // {}) + (.data // {}) | keys | .[] | select(. == strenv(K) + ".ulaw" or . == strenv(K) + ".gsm" or . == strenv(K) + ".wav")' \
        "$SITE_DIR/sounds.yaml" >/dev/null 2>&1 || missing+=("$ref")
    done
  done < <(yq '.containers[] | select(.name == "asterisk") | (.volumeMounts // [])[] | [.mountPath, .name] | @tsv' "$pod")
  if ((${#missing[@]})); then
    fail "the dialplan plays prompts its ConfigMap does not carry (give Playback no extension)" "${missing[@]}"
  fi
}

check_inbound() {
  local out
  ast 'dialplan show' >"$SITE_DIR/dialplan.txt"
  if out=$(awk -v roots="$INBOUND_ROOTS" -f "$WALKER" "$SITE_DIR/dialplan.txt"); then
    say "    $out"
  else
    fail "a caller can reach something that is not theirs to reach" "$out"
  fi
}

# --- main ------------------------------------------------------------------

check_site() {
  local site=$1
  SITE_FAILURES=0
  SITE_DIR="$WORK/$site"
  mkdir -p "$SITE_DIR"
  say "==> $site"
  render "$site" full || return 1
  check_sounds
  localize || return 1
  check_no_pjsip_noload
  boot || return 1
  say "    booted ($ISOLATION)"
  run_checks "$site"
  stop_asterisk

  if ((HAS_OPTIONAL)); then
    SITE_DIR="$WORK/$site-degraded"
    mkdir -p "$SITE_DIR"
    say "==> $site (degraded: optional secrets absent)"
    if render "$site" degraded; then
      check_sounds
      if localize; then
        check_no_pjsip_noload
        if boot; then
          say "    booted ($ISOLATION)"
          run_checks "$site"
        fi
      fi
    fi
    stop_asterisk
  fi

  ((SITE_FAILURES == 0))
}

# The checks a boot must pass, whether it ran with every optional secret
# present or with them dropped entirely.
run_checks() {
  local site=$1
  check_boot_log
  check_pjsip_objects
  check_reload_and_handsets "$site"
  check_events
  check_inbound_routes "$site"
  check_inbound
}

main() {
  local -a sites=("$@") failed=()
  local site
  if ((${#sites[@]} == 0)); then
    for site in clusters/*/apps/pbx; do
      site=${site#clusters/}
      site=${site%%/*}
      [[ $site == base ]] || sites+=("$site")
    done
  fi
  for site in "${sites[@]}"; do
    [[ $site != base && -d clusters/$site/apps/pbx ]] || die "no PBX overlay at clusters/$site/apps/pbx"
  done

  WORK=$(mktemp -d "${TMPDIR:-/tmp}/pbx-check.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  pick_isolation
  resolve_toolchain

  for site in "${sites[@]}"; do
    if ! check_site "$site"; then
      failed+=("$site")
      stop_asterisk
    fi
  done

  if ((${#failed[@]})); then
    say "pbx-check: FAILED for ${failed[*]}"
    exit 1
  fi
  say "pbx-check: ok for ${sites[*]} (Asterisk $ASTERISK_VERSION)"
}

main "$@"
