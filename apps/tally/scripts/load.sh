#!/usr/bin/env bash
# Load the import root into the live ledger: `tally load`, reaching the server
# directly when the configured server_url answers, else through a port-forward
# to the tally Service on folly. Every argument goes to `tally load`.
set -euo pipefail
cd "$(dirname "$0")/.."

url="${TALLY_SERVER_URL:-$(uv run python -c 'from tally import config; print(config.load().server_url)')}"
forward=""
if ! curl -fsS -m 5 -o /dev/null "${url%/}/healthz" 2>/dev/null; then
  kubectl --context folly -n tally port-forward svc/tally 18080:8080 >/dev/null 2>&1 &
  forward=$!
  trap 'kill "$forward" 2>/dev/null || true' EXIT
  url="http://127.0.0.1:18080"
  for _ in $(seq 1 30); do
    curl -fsS -m 2 -o /dev/null "$url/healthz" 2>/dev/null && break
    sleep 1
  done
  echo "reaching tally through a port-forward to folly" >&2
fi

TALLY_SERVER_URL="$url" uv run tally load "$@"
