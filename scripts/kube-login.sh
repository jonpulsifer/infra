#!/usr/bin/env bash
# kube-login.sh <folly|offsite>
#
# Adds the site's cluster, a user that signs in at Google through kubelogin and
# the context <site> to ~/.kube/config (or $KUBECONFIG), and selects the context,
# the way `gcloud container clusters get-credentials` does for GKE. The server and port come from the site's cluster-topology.json, the CA
# from clusters/<site>/config/kubernetes-ca.crt, the issuer and client ID from
# clusters/base/config/kube-login.json, and the client secret from the
# 1Password reference that file names, read at write time and kept only in
# the kubeconfig, which the script leaves at mode 0600.
#
# The first kubectl call opens a browser at Google; kubelogin keeps the tokens
# under ~/.kube/cache/oidc-login and refreshes them without a new sign-in.
set -euo pipefail

site=${1:-}
case "$site" in
  folly | offsite) ;;
  *)
    echo "usage: kube-login.sh <folly|offsite>" >&2
    exit 2
    ;;
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
issuer=$(jq -er .providers.google.issuer "$login")
client_id=$(jq -er .providers.google.client_id "$login")
if [ -z "$client_id" ]; then
  echo "clusters/base/config/kube-login.json names no Google client_id yet" >&2
  exit 1
fi
secret_ref=$(jq -er .providers.google.secret "$login")
secret=$(op read "$secret_ref")

out=${KUBECONFIG:-$HOME/.kube/config}
case "$out" in *:*)
  echo "KUBECONFIG names more than one file; set it to the one to write" >&2
  exit 1
  ;;
esac
umask 077
mkdir -p "$(dirname "$out")"
cfg() { KUBECONFIG=$out kubectl config "$@" >/dev/null; }
cfg set-cluster "$site" --server="https://$host:$port" --certificate-authority="$ca" --embed-certs=true
# One extra param only: kubelogin hashes its token-cache key with gob, and the extra
# params are a map, so two or more make the key random and most calls miss the cache.
# prompt=consent is the one Google needs for a refresh token on every sign-in; the
# hosted domain is enforced by the API server, not asked of Google.
cfg set-credentials "google@$site" \
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
  --exec-arg=--oidc-auth-request-extra-params=prompt=consent
cfg set-context "$site" --cluster="$site" --user="google@$site"
cfg use-context "$site"
chmod 600 "$out"

echo "context $site is current in $out"
