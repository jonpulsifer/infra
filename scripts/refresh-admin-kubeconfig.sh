#!/usr/bin/env bash
# Copy a cluster's `cluster-admin` certificate out of its control plane and into
# the operator's kubeconfig.
#
#   mise run k8s:refresh-admin              # every cluster with something new
#   mise run k8s:refresh-admin -- folly     # one cluster; mise needs the `--`
#
# certmgr renews the control plane's own copy on the host, 72h before it lapses.
# Nothing carries that renewal into `~/.kube/config`, so the operator's copy is
# the one credential in the estate that expires with no automation behind it —
# every 30 days, silently, until kubectl stops working. This is that missing
# step, run on demand.
#
# It needs no certificate parser. "Is the host's copy new?" is answered by
# comparing bytes, because certmgr only ever issues forward, and "is this
# credential good?" is answered by authenticating with it — which tests the
# cert, its key, and the pairing at once, where a modulus comparison would test
# only the last. A credential that does not authenticate is rolled back rather
# than left in place.
#
# Clusters come from clusters/*/ and the control-plane host from the live node
# list, so a new site needs no edit here.
set -euo pipefail

readonly KUBECONFIG_PATH=${KUBECONFIG:-$HOME/.kube/config}
only=${1:-}
work=$(mktemp -d)
trap 'find "$work" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$work"' EXIT

# The certificate currently in the kubeconfig, or an empty file when there is
# none to compare against.
installed_cert() {
  kubectl config view --raw -o json 2>/dev/null | jq -r --arg u "$1" '
    .users[]? | select(.name == $u) | .user["client-certificate-data"] // empty
  ' | base64 -d 2>/dev/null || true
}

# `notAfter`, when there is a parser to read it with. Cosmetic: it sharpens the
# report and nothing branches on it, so the script still runs without one.
expiry_note() {
  local pem=$1 line
  command -v openssl >/dev/null || return 0
  line=$(openssl x509 -in "$pem" -noout -enddate 2>/dev/null) || return 0
  printf ', expires %s' "$(date -u -d "${line#notAfter=}" +%Y-%m-%dT%H:%MZ 2>/dev/null)"
}

refresh() {
  local ctx=$1 user="${1}-admin" host node

  if ! node=$(kubectl --context "$ctx" get nodes \
    -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) \
    || [[ -z $node ]]; then
    printf '%s\tskipped\tno reachable control-plane node\n' "$ctx"
    return 0
  fi
  host="${node}.lolwtf.ca"

  if ! ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" \
    'sudo cat /var/lib/kubernetes/secrets/cluster-admin.pem' >"$work/$ctx.pem" 2>/dev/null \
    || [[ ! -s $work/$ctx.pem ]]; then
    printf '%s\tskipped\t%s unreachable, or sudo refused\n' "$ctx" "$host"
    return 0
  fi
  ssh -o BatchMode=yes "$host" \
    'sudo cat /var/lib/kubernetes/secrets/cluster-admin-key.pem' >"$work/$ctx-key.pem" 2>/dev/null
  if [[ ! -s $work/$ctx-key.pem ]]; then
    printf '%s\tskipped\tthe key on %s could not be read\n' "$ctx" "$host"
    return 0
  fi

  # certmgr only issues forward, so identical bytes mean there is nothing to
  # carry over. Run before its renewal window and the host still holds the same
  # expiring certificate; installing that would report success and buy nothing.
  installed_cert "$user" >"$work/$ctx-installed.pem"
  if cmp -s "$work/$ctx.pem" "$work/$ctx-installed.pem"; then
    printf '%s\tunchanged\tthe kubeconfig already holds the host'\''s copy%s\n' \
      "$ctx" "$(expiry_note "$work/$ctx.pem")"
    return 0
  fi

  kubectl config set-credentials "$user" \
    --client-certificate="$work/$ctx.pem" \
    --client-key="$work/$ctx-key.pem" \
    --embed-certs=true >/dev/null

  # The real test: a certificate without its matching key, or one this cluster
  # will not accept, locks the operator out of the cluster they meant to reach.
  if ! kubectl --context "$ctx" get --raw /version >/dev/null 2>&1; then
    cp "$backup" "$KUBECONFIG_PATH"
    printf '%s\tROLLED BACK\tthe new credential did not authenticate; kubeconfig restored\n' "$ctx"
    return 1
  fi
  printf '%s\tupdated\tauthenticated against the cluster%s\n' \
    "$ctx" "$(expiry_note "$work/$ctx.pem")"
}

for binary in jq kubectl ssh; do
  command -v "$binary" >/dev/null || {
    printf 'need %s on PATH\n' "$binary" >&2
    exit 1
  }
done

backup="${KUBECONFIG_PATH}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup
cp "$KUBECONFIG_PATH" "$backup"
printf 'kubeconfig backed up to %s\n\n' "$backup"

# Rows are collected before they are printed, so that a rollback sets the exit
# status here rather than in `column`'s subshell, where it would be lost.
status=0
rows=$(printf 'CLUSTER\tRESULT\tDETAIL\n')
for dir in clusters/*/; do
  ctx=$(basename "$dir")
  [[ $ctx == base ]] && continue
  [[ -n $only && $ctx != "$only" ]] && continue
  row=$(refresh "$ctx") || status=1
  rows+=$'\n'${row}
done

column -t -s"$(printf '\t')" <<<"$rows"

exit "$status"
