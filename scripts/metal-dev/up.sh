#!/usr/bin/env bash
# Starts the metal-dev VM, puts it on the tailnet, and gives it the DNS-01 token that the
# enrollment name's certificate needs. Both secrets come from 1Password and travel over stdin.
# The token stays on the VM's disk at /var/lib/metal-dev/cloudflare-token.
#
#   METAL_DEV_TAILSCALE_KEY_REF   op:// reference of a reusable tailnet auth key tagged tag:gcp,
#                                 default op://homelab/tailscale-metal-dev/credential
#   METAL_DEV_CLOUDFLARE_REF      op:// reference of a Cloudflare token scoped to DNS edits on the
#                                 lab's zone, made for this VM, never cert-manager's,
#                                 default op://homelab/cloudflare-dns01-metal-dev/credential
set -euo pipefail

# shellcheck source=scripts/metal-dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
: "${METAL_DEV_TAILSCALE_KEY_REF:=op://homelab/tailscale-metal-dev/credential}"
: "${METAL_DEV_CLOUDFLARE_REF:=op://homelab/cloudflare-dns01-metal-dev/credential}"

# An auth or API error surfaces as is; only a missing VM is the message below.
if ! status="$(gcloud_instance describe --format='value(status)' 2>&1)"; then
  if grep -q "was not found" <<<"$status"; then
    echo "no $instance VM in $METAL_DEV_PROJECT: set on = true in terraform/metal-dev and apply it through Atlantis" >&2
  else
    echo "$status" >&2
  fi
  exit 1
fi

# A VM on its way down or to sleep cannot be started; wait for it to settle first.
for _ in $(seq 30); do
  case "$status" in
    STOPPING | SUSPENDING | PROVISIONING | STAGING | REPAIRING)
      echo "$instance is $status; waiting"
      sleep 10
      status="$(gcloud_instance describe --format='value(status)')"
      ;;
    *) break ;;
  esac
done
case "$status" in
  RUNNING) echo "$instance is running" ;;
  SUSPENDED)
    echo "resuming $instance"
    gcloud_instance resume >/dev/null
    ;;
  TERMINATED | STOPPED)
    echo "starting $instance"
    gcloud_instance start >/dev/null
    ;;
  *)
    echo "$instance is $status, which this script does not handle" >&2
    exit 1
    ;;
esac

echo "waiting for ssh through IAP"
for _ in $(seq 36); do
  if iap_ssh true 2>/dev/null; then break; fi
  sleep 10
done
iap_ssh true

if ! iap_ssh 'tailscale status >/dev/null 2>&1'; then
  echo "joining the tailnet"
  op read "$METAL_DEV_TAILSCALE_KEY_REF" |
    iap_ssh 'umask 077; cat >/tmp/ts.key && sudo tailscale up --auth-key "file:/tmp/ts.key" --advertise-tags=tag:gcp --accept-routes=false; rm -f /tmp/ts.key'
fi

echo "placing the DNS-01 token"
op read "$METAL_DEV_CLOUDFLARE_REF" |
  iap_ssh 'sudo install -m 600 -o root -g root /dev/stdin /var/lib/metal-dev/cloudflare-token && sudo systemctl restart "acme-enroll.*.service" 2>/dev/null || true'

echo "mirroring the newest signed release"
iap_ssh 'sudo systemctl start metal-dev-talos-mirror.service && systemctl is-active netbox.service metal-dev-tinkerbell.service podman-sushy.service podman-talos-enroll.service podman-talos-attest.service podman-fleet-controller.service || true'

host="$(tailnet_host)"
cat <<EOF
metal-dev is up.
  NetBox:        http://$host:8080  (admin; password in /var/lib/metal-dev/netbox/superuser-password on the host)
  seed NetBox:   mise run metal-dev:seed   (first time, and after a seed change)
  intake a node: mise run metal-dev:intake
  console:       ssh $host sudo virsh console vnode1
EOF
