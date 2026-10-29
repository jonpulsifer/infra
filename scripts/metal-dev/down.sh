#!/usr/bin/env bash
# Stops the metal-dev VM. Its disk, and every virtual node on it, stays.
set -euo pipefail

# shellcheck source=scripts/metal-dev/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

status="$(gcloud_instance describe --format='value(status)' 2>/dev/null || true)"
case "$status" in
  "") echo "no $instance VM in $METAL_DEV_PROJECT" ;;
  TERMINATED | STOPPED) echo "$instance is already stopped" ;;
  *)
    echo "stopping $instance ($status)"
    gcloud_instance stop >/dev/null
    ;;
esac
