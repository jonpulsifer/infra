#!/usr/bin/env bash
# slurmrestd over HTTP with a JWT. scontrol mints the token here; outside
# the login pod the operator keeps the same kind of token in the Secret
# slurm-token-root.
set -euo pipefail

api=${SLURM_RESTAPI:-http://slurm-restapi:6820}
version=${SLURM_API_VERSION:-v0.0.44}
token=$(scontrol token lifespan=300 | cut -d= -f2)

get() {
  curl -sS --fail-with-body \
    -H "X-SLURM-USER-NAME: root" -H "X-SLURM-USER-TOKEN: $token" \
    "$api/slurm/$version/$1"
}

echo "== ping"
get ping
echo
echo "== nodes"
get nodes | tr ',' '\n' | grep -E '"name"|"state"' | head -12
echo
echo "== submit a job"
curl -sS --fail-with-body -X POST \
  -H "X-SLURM-USER-NAME: root" -H "X-SLURM-USER-TOKEN: $token" \
  -H 'Content-Type: application/json' \
  -d '{"job":{"name":"rest","current_working_directory":"/tmp","environment":["PATH=/usr/bin:/bin"],"script":"#!/bin/bash\nhostname"}}' \
  "$api/slurm/$version/job/submit"
echo
squeue --me -o "%.8i %.8j %.8T %R" | head
