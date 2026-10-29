#!/usr/bin/env bash
# Runs one virtual node through intake on the metal-dev host: metal-dev-intake (nix/hosts/metal-dev.nix)
# creates the VM, enrolls the lab's Secure Boot keys from the signed ISO, declares the node in the
# host's NetBox with desired_action=provision, and follows its NetBox status until active.
#
# The host's NetBox needs the fleet schema first: NETBOX_URL=http://<host>:8080 and the host's
# token (/var/lib/metal-dev/netbox/api-token) with scripts/netbox-seed.sh.
set -euo pipefail

# shellcheck source=scripts/metal-dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

host="$(tailnet_host)"
name="${1:-vnode1}"
exec ssh -t "$host" sudo metal-dev-intake "$name"
