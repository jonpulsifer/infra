#!/usr/bin/env bash
# Renders the shared app seams for both cluster adapters without touching live state.
set -euo pipefail

for overlay in \
  clusters/folly/apps \
  clusters/offsite/apps \
  clusters/folly/apps/arc \
  clusters/offsite/apps/arc; do
  kubectl kustomize "$overlay" >/dev/null
  printf 'rendered %s\n' "$overlay"
done
