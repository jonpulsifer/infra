#!/usr/bin/env bash
set -euo pipefail
if command -v mise >/dev/null 2>&1; then
  exit 0
fi
echo "chezmoi: installing mise (https://mise.jdx.dev)" >&2
curl -fsSL https://mise.run | sh
