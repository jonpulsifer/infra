#!/usr/bin/env bash
# Contention: a job that takes every node exclusively, then a small job
# behind it. The small job waits with reason Resources until the big one
# ends, then runs. A third job asks for more nodes than exist.
set -euo pipefail

nodes=$(sinfo -h -t idle -o %D | head -1)
[ "${nodes:-0}" -gt 0 ] || {
  echo "no idle node; sinfo says:"
  sinfo
  exit 1
}

big=$(sbatch --parsable --job-name=hog --nodes="$nodes" --exclusive --output=/dev/null --wrap='sleep 20')
small=$(sbatch --parsable --job-name=small --ntasks=1 --output=/dev/null --wrap='hostname')
never=$(sbatch --parsable --job-name=toobig --nodes=$((nodes + 1)) --output=/dev/null --wrap='true' 2>/dev/null || echo rejected)

echo "== hog $big took all $nodes nodes; small $small waits; toobig: $never"
for _ in $(seq 10); do
  echo "-- $(date +%T)"
  squeue -o "%.8i %.8j %.8T %.10M %.6D %R"
  squeue -h --job "$small" | grep -q . || break
  sleep 4
done

if [ "$never" != rejected ]; then
  echo
  echo "== why toobig never runs"
  scontrol show job "$never" | grep -E "JobState|Reason"
  scancel "$never"
fi
