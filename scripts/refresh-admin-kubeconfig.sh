#!/usr/bin/env bash
# Copy a cluster's `cluster-admin` certificate out of its control plane and into
# the operator's kubeconfig.
#
#   mise run k8s:refresh-admin           # every cluster that needs it
#   mise run k8s:refresh-admin folly     # just one
#
# certmgr renews the control plane's own copy on the host, 72h before it lapses.
# Nothing carries that renewal into `~/.kube/config`, so the operator's copy is
# the one credential in the estate that expires with no automation behind it —
# every 30 days, silently, until kubectl stops working. This is that missing
# step, run on demand.
#
# It refuses rather than guesses: a cert that is not newer than the installed
# one is left alone (running before certmgr's window would otherwise reinstall
# the same expiring cert and look like success), and a key that does not match
# its certificate is never written.
#
# Clusters come from clusters/*/ and the control-plane host from the live node
# list, so a new site needs no edit here.
set -euo pipefail

readonly KUBECONFIG_PATH=${KUBECONFIG:-$HOME/.kube/config}
only=${1:-}
work=$(mktemp -d)
trap 'find "$work" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$work"' EXIT

# `notAfter` as a unix timestamp, or empty when the input is not a certificate.
expiry_of() {
  local pem=$1 date_str
  date_str=$(openssl x509 -in "$pem" -noout -enddate 2>/dev/null) || return 0
  date -d "${date_str#notAfter=}" +%s 2>/dev/null || true
}

installed_cert() {
  local user=$1 out=$2
  kubectl config view --raw -o json 2>/dev/null | jq -r --arg u "$user" '
    .users[]? | select(.name == $u) | .user["client-certificate-data"] // empty
  ' | base64 -d >"$out" 2>/dev/null || true
}

refresh() {
  local ctx=$1 user="${1}-admin" host node fresh installed

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

  # A cert without its matching key locks the operator out of the cluster.
  local cert_key key_key
  cert_key=$(openssl x509 -in "$work/$ctx.pem" -noout -pubkey 2>/dev/null | openssl md5)
  key_key=$(openssl pkey -in "$work/$ctx-key.pem" -pubout 2>/dev/null | openssl md5)
  if [[ $cert_key != "$key_key" || -z $cert_key ]]; then
    printf '%s\tREFUSED\tthe key on %s does not match its certificate\n' "$ctx" "$host"
    return 1
  fi

  fresh=$(expiry_of "$work/$ctx.pem")
  installed_cert "$user" "$work/$ctx-installed.pem"
  installed=$(expiry_of "$work/$ctx-installed.pem")

  if [[ -n $installed && -n $fresh && $fresh -le $installed ]]; then
    # Either the kubeconfig already holds this generation, or certmgr has not
    # reached its renewal window yet. Both mean there is nothing to copy, and
    # copying anyway would reinstall a cert with the same expiry and read as
    # success.
    printf '%s\tunchanged\tinstalled copy is already the current one (expires %s)\n' \
      "$ctx" "$(date -u -d "@$fresh" +%Y-%m-%dT%H:%MZ)"
    return 0
  fi

  kubectl config set-credentials "$user" \
    --client-certificate="$work/$ctx.pem" \
    --client-key="$work/$ctx-key.pem" \
    --embed-certs=true >/dev/null

  if ! kubectl --context "$ctx" get --raw /version >/dev/null 2>&1; then
    printf '%s\tFAILED\tthe new credential does not authenticate; kubeconfig backup is beside it\n' "$ctx"
    return 1
  fi
  printf '%s\tupdated\tnow expires %s\n' "$ctx" "$(date -u -d "@$fresh" +%Y-%m-%dT%H:%MZ)"
}

for binary in openssl jq kubectl ssh; do
  command -v "$binary" >/dev/null || {
    printf 'need %s on PATH; the nix dev shell has it\n' "$binary" >&2
    exit 1
  }
done

backup="${KUBECONFIG_PATH}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
cp "$KUBECONFIG_PATH" "$backup"
printf 'kubeconfig backed up to %s\n\n' "$backup"

# Rows are collected before they are printed, so that a refusal sets the exit
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
