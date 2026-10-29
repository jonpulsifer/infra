#!/usr/bin/env bash
# Shared by the metal-dev scripts: where the VM is, and how to reach it.
#
#   METAL_DEV_PROJECT   GCP project, default homelab-ng
#   METAL_DEV_ZONE      zone, default northamerica-northeast1-a (terraform/metal-dev/versions.tf)
#   METAL_DEV_HOST      the host's tailnet name, default metal-dev.<MagicDNS suffix>

: "${METAL_DEV_PROJECT:=homelab-ng}"
: "${METAL_DEV_ZONE:=northamerica-northeast1-a}"
readonly instance="metal-dev"

gcloud_instance() {
  gcloud compute instances "$1" "$instance" --project "$METAL_DEV_PROJECT" --zone "$METAL_DEV_ZONE" "${@:2}"
}

# iap_ssh <command...>: a shell on the VM through IAP, before it is on the tailnet. Stdin passes
# through, so a secret travels as a pipe and never as an argument.
iap_ssh() {
  gcloud compute ssh "jawn@$instance" --project "$METAL_DEV_PROJECT" --zone "$METAL_DEV_ZONE" \
    --tunnel-through-iap --quiet -- -o StrictHostKeyChecking=accept-new "$@"
}

tailnet_host() {
  if [[ -n "${METAL_DEV_HOST:-}" ]]; then
    printf '%s' "$METAL_DEV_HOST"
    return
  fi
  local suffix
  suffix="$(tailscale status --json | jq -r '.MagicDNSSuffix // empty')"
  [[ -n "$suffix" ]] || {
    echo "tailscale reports no MagicDNS suffix; set METAL_DEV_HOST" >&2
    return 1
  }
  printf 'metal-dev.%s' "$suffix"
}
