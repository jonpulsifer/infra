#!/usr/bin/env bash
# The worker subset of a Talos secrets bundle: what a worker's config carries,
# which is tokens, identifiers and CA certificates, never a CA private key.
# fleetd renders workers from it (apps/fleetd/README.md), so a spore that
# holds only the subset cannot mint a control-plane config or a talosconfig.
#
#   talos-worker-secrets.sh derive <bundle.yaml>    print the subset
#   talos-worker-secrets.sh seal <anchor|file>      read the sealed bundle in
#                                                   nix/secrets/<anchor>.sops.yaml
#                                                   (or the sops file given),
#                                                   seal the subset beside it as
#                                                   fleetd/worker-secrets
#   talos-worker-secrets.sh drop-bundle <anchor|file>
#                                                   remove fleetd/bundle once the
#                                                   subset is sealed
#
# seal and drop-bundle need SOPS_AGE_KEY_FILE. Nothing decrypted touches the
# disk or the terminal.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root

derive() {
  yq '{
    "cluster": {"id": .cluster.id, "secret": .cluster.secret},
    "secrets": {"bootstraptoken": .secrets.bootstraptoken},
    "trustdinfo": {"token": .trustdinfo.token},
    "certs": {"k8s": {"crt": .certs.k8s.crt}, "os": {"crt": .certs.os.crt}}
  }' "$1"
}

check() {
  # Every value is present, and no key slipped through.
  yq -e '
    .cluster.id != null and .cluster.secret != null and .secrets.bootstraptoken != null
    and .trustdinfo.token != null and .certs.k8s.crt != null and .certs.os.crt != null
    and ([.. | select(tag == "!!map" and has("key"))] | length) == 0' "$1" >/dev/null \
    || {
      echo "the subset is incomplete, or carries a key" >&2
      exit 1
    }
}

sops_file() {
  if [ -f "$1" ]; then
    printf '%s\n' "$1"
  else
    printf '%s\n' "$root/nix/secrets/$1.sops.yaml"
  fi
}

case "${1:-}" in
  derive)
    [ -n "${2:-}" ] || {
      echo "usage: $0 derive <bundle.yaml>" >&2
      exit 2
    }
    derive "$2"
    ;;
  seal)
    file="$(sops_file "${2:?usage: $0 seal <anchor|file>}")"
    subset="$(sops decrypt --extract '["fleetd"]["bundle"]' "$file" | derive /dev/stdin)"
    check <(printf '%s\n' "$subset")
    # sops takes the new value as JSON, so the YAML document goes in as one string.
    printf '%s\n' "$subset" | jq -Rs . | sops set --value-stdin "$file" '["fleetd"]["worker-secrets"]'
    echo "==> sealed fleetd/worker-secrets into ${file#"$root"/}" >&2
    ;;
  drop-bundle)
    file="$(sops_file "${2:?usage: $0 drop-bundle <anchor|file>}")"
    sops decrypt --extract '["fleetd"]["worker-secrets"]' "$file" >/dev/null \
      || {
        echo "seal the worker subset first" >&2
        exit 1
      }
    sops unset "$file" '["fleetd"]["bundle"]'
    echo "==> removed fleetd/bundle from ${file#"$root"/}" >&2
    ;;
  *)
    sed -n '2,18p' "$0" >&2
    exit 2
    ;;
esac
