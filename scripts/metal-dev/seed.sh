#!/usr/bin/env bash
# Seeds the metal-dev VM's own NetBox with scripts/netbox-seed.sh. It pins NETBOX_URL to the VM
# and reads the VM's token over ssh into a private file, so the seed can never reach the lab's
# NetBox from here. Run it once after the first metal-dev:up, and again after a seed change.
set -euo pipefail

# shellcheck source=scripts/metal-dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

host="$(tailnet_host)"
token_file="$(mktemp)"
trap 'rm -f "$token_file"' EXIT
chmod 600 "$token_file"
ssh "$host" sudo cat /var/lib/metal-dev/netbox/api-token >"$token_file"
[[ -s "$token_file" ]] || {
  echo "the VM has no NetBox token yet; wait for metal-dev-netbox-token.service" >&2
  exit 1
}

NETBOX_URL="http://$host:8080" NETBOX_TOKEN_FILE="$token_file" NETBOX_TOKEN="" \
  bash "$root/scripts/netbox-seed.sh" "$@"
