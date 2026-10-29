#!/usr/bin/env bash
# Writes the ConfigMap that tpm-reattest checks a renewed LDevID against: every issuing DevID CA, from
# terraform/pki/certs/folly-devid-ca.pem. With --check it fails if the committed file differs.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
readonly bundle="$root/terraform/pki/certs/folly-devid-ca.pem"
readonly out="$root/clusters/folly/apps/spire/devid-ca.yaml"

check=false
case "${1:-}" in
  --check) check=true ;;
  "") ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 64
    ;;
esac

grep -q 'BEGIN CERTIFICATE' "$bundle" || {
  echo "$bundle holds no certificate" >&2
  exit 1
}

rendered="$(
  cat <<'EOF'
---
# Every issuing DevID CA, the trust anchors tpm-reattest checks a renewed LDevID and LAK against.
# Written by scripts/render-spire-devid-ca.sh from terraform/pki/certs/folly-devid-ca.pem; the
# kustomize workflow fails when the two differ.
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-devid-ca
  namespace: spire
  labels:
    app.kubernetes.io/name: tpm-reattest
    app.kubernetes.io/part-of: spire
data:
  devid-ca.pem: |
EOF
  sed 's/^/    /' "$bundle"
)"

if $check; then
  if ! diff -u "$out" <(printf '%s\n' "$rendered"); then
    echo "${out#"$root/"} is stale; run scripts/render-spire-devid-ca.sh and commit the result" >&2
    exit 1
  fi
else
  printf '%s\n' "$rendered" >"$out"
fi
