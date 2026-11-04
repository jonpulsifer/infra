#!/usr/bin/env bash
# kube-login.sh <folly|offsite> [--provider google|tailscale]
#
# Adds the site's cluster, a user that signs in at Google, or at tsidp on the
# tailnet with --provider tailscale, through kubelogin and the context <site> to
# ~/.kube/config (or $KUBECONFIG), and selects the context, the way
# `gcloud container clusters get-credentials` does for GKE. The user is
# <provider>@<site>, and the other provider's user for the site goes, so no stale
# client secret stays behind. The server and port come from the site's
# cluster-topology.json, the CA from clusters/<site>/config/kubernetes-ca.crt,
# the provider's client ID from clusters/base/config/kube-login.json, and the
# client secret from the 1Password reference that file names, read at write time
# and kept only in the kubeconfig, which the script leaves at mode 0600. Google's
# issuer is in the file; tsidp's is its hostname on the tailnet that
# terraform/network/tailscale/fleet.tf.json names.
#
# The first kubectl call opens a browser at the provider; kubelogin keeps the
# tokens under ~/.kube/cache/oidc-login and refreshes them without a new
# sign-in.
set -euo pipefail

usage() {
  echo "usage: kube-login.sh <folly|offsite> [--provider google|tailscale]" >&2
  exit 2
}

site=${1:-}
case "$site" in
  folly | offsite) shift ;;
  *) usage ;;
esac
provider=google
while [ $# -gt 0 ]; do
  case "$1" in
    --provider)
      provider=${2:-}
      shift 2 || usage
      ;;
    --provider=*)
      provider=${1#--provider=}
      shift
      ;;
    *) usage ;;
  esac
done
case "$provider" in
  google | tailscale) ;;
  *) usage ;;
esac

repo=$(cd "$(dirname "$0")/.." && pwd)
topology=$repo/clusters/$site/config/cluster-topology.json
ca=$repo/clusters/$site/config/kubernetes-ca.crt
login=$repo/clusters/base/config/kube-login.json
for tool in jq kubectl op; do
  command -v "$tool" >/dev/null || {
    echo "$tool is not installed; run mise install" >&2
    exit 1
  }
done
kubectl oidc-login --version >/dev/null 2>&1 || {
  echo "kubelogin (kubectl oidc-login) is not installed; run mise install" >&2
  exit 1
}

host=$(jq -er .data.API_SERVER_HOSTNAME "$topology")
port=$(jq -er .data.API_SERVER_PORT "$topology")
client_id=$(jq -er ".providers.$provider.client_id" "$login")
if [ -z "$client_id" ]; then
  echo "clusters/base/config/kube-login.json names no $provider client_id yet" >&2
  exit 1
fi
secret=$(op read "$(jq -er ".providers.$provider.secret" "$login")")

# One extra param at most: kubelogin hashes its token-cache key with gob, and the extra
# params are a map, so two or more make the key random and most calls miss the cache.
# prompt=consent is the one Google needs for a refresh token on every sign-in; the
# hosted domain is enforced by the API server, not asked of Google. tsidp needs none.
case "$provider" in
  google)
    other=tailscale
    issuer=$(jq -er .providers.google.issuer "$login")
    extra=(--exec-arg=--oidc-auth-request-extra-params=prompt=consent)
    ;;
  tailscale)
    other=google
    tailnet=$(jq -er .locals.fleet.tailnet "$repo/terraform/network/tailscale/fleet.tf.json")
    issuer=https://$(jq -er .providers.tailscale.hostname "$login").$tailnet
    extra=()
    ;;
esac

out=${KUBECONFIG:-$HOME/.kube/config}
case "$out" in *:*)
  echo "KUBECONFIG names more than one file; set it to the one to write" >&2
  exit 1
  ;;
esac
user=$provider@$site
umask 077
mkdir -p "$(dirname "$out")"
cfg() { KUBECONFIG=$out kubectl config "$@" >/dev/null; }
cfg set-cluster "$site" --server="https://$host:$port" --certificate-authority="$ca" --embed-certs=true
cfg set-credentials "$user" \
  --exec-api-version=client.authentication.k8s.io/v1 \
  --exec-interactive-mode=Never \
  --exec-command=kubectl \
  --exec-arg=oidc-login \
  --exec-arg=get-token \
  --exec-arg="--oidc-issuer-url=$issuer" \
  --exec-arg="--oidc-client-id=$client_id" \
  --exec-arg="--oidc-client-secret=$secret" \
  --exec-arg=--oidc-extra-scope=email \
  --exec-arg=--oidc-extra-scope=profile \
  ${extra[@]+"${extra[@]}"}
cfg set-context "$site" --cluster="$site" --user="$user"
cfg use-context "$site"
cfg delete-user "$other@$site" 2>/dev/null || true
chmod 600 "$out"

echo "context $site is current in $out, as the user $user"
