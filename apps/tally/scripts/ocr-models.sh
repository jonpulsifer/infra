#!/usr/bin/env bash
# Install tally's `ocr` extra (Docling) into the local env and download its
# models into ~/.cache/tally/docling, so `scripts/load.sh` reads scans offline.
set -euo pipefail
cd "$(dirname "$0")/.."

models="${TALLY_DOCLING_MODELS:-$HOME/.cache/tally/docling}"
if [ -n "${NIX_LD_LIBRARY_PATH:-}" ]; then
  export LD_LIBRARY_PATH="${NIX_LD_LIBRARY_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
uv sync --all-groups --extra ocr
mkdir -p "$models"
uv run docling-tools models download -o "$models" 2>&1 | grep -v '%|' || true
uv run python -c "import docling" && echo "OCR ready: models in $models"
