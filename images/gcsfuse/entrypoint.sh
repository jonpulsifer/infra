#!/usr/bin/env bash
# Mounts $BUCKET read-only at $MOUNT and unmounts on SIGTERM. A mount left
# behind on the node's emptyDir path wedges the kubelet's volume teardown.
set -uo pipefail

: "${BUCKET:?BUCKET names the bucket to mount}"
: "${MOUNT:?MOUNT names the mount point}"

fusermount3 -uz "$MOUNT" 2>/dev/null || true
mkdir -p "$MOUNT"

child=
stop() {
  fusermount3 -u "$MOUNT" || true
  [[ -n "$child" ]] && kill "$child" 2>/dev/null
  exit 0
}
trap stop TERM INT

gcsfuse --foreground --implicit-dirs -o ro -o allow_other \
  --metadata-cache-ttl-secs 10 "$BUCKET" "$MOUNT" &
child=$!
wait "$child"
