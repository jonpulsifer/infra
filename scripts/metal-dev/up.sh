#!/usr/bin/env bash
# Starts the metal-dev VM, waits for it to join the tailnet, and gives it the DNS-01 token that
# the enrollment name's certificate needs. The VM joins by itself at boot with its service
# account's identity (metal-dev-tailscale-up), so no tailnet key exists to hand it. The token
# comes from 1Password over stdin and stays on the VM's disk at /var/lib/metal-dev/cloudflare-token.
#
#   METAL_DEV_CLOUDFLARE_REF      op:// reference of a Cloudflare token scoped to DNS edits on the
#                                 lab's zone, made for this VM, never cert-manager's,
#                                 default op://homelab/cloudflare-dns01-metal-dev/credential
set -euo pipefail

# shellcheck source=scripts/metal-dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
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

echo "waiting for the tailnet join"
# shellcheck disable=SC2016 # the loop runs on the VM
if ! iap_ssh 'for _ in $(seq 24); do tailscale status >/dev/null 2>&1 && exit 0; sleep 5; done; exit 1'; then
  echo "$instance is not on the tailnet; its journal says why:" >&2
  iap_ssh 'sudo journalctl -u metal-dev-tailscale-up.service -n 20 --no-pager' >&2 || true
  exit 1
fi

echo "placing the DNS-01 token"
op read "$METAL_DEV_CLOUDFLARE_REF" \
  | iap_ssh 'sudo install -m 600 -o root -g root /dev/stdin /var/lib/metal-dev/cloudflare-token && sudo systemctl restart "acme-enroll.*.service" 2>/dev/null || true'

echo "mirroring the newest signed release"
iap_ssh 'sudo systemctl start metal-dev-talos-mirror.service && systemctl is-active netbox.service metal-dev-tinkerbell.service podman-sushy.service podman-talos-attest.service podman-fleet-controller.service || true'

host="$(tailnet_host)"
cat <<EOF
metal-dev is up.
  NetBox:        http://$host:8080  (admin; password in /var/lib/metal-dev/netbox/superuser-password on the host)
  seed NetBox:   mise run metal-dev:seed   (first time, and after a seed change)
  intake a node: mise run metal-dev:intake
  console:       ssh $host sudo virsh console vnode1
EOF
