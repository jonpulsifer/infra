#!/usr/bin/env bash
# Contention: a job that takes every CPU, then a small job behind it. The
# small job waits with reason Resources until the big one ends, then runs.
# A third job asks for more nodes than exist and never runs.
set -euo pipefail

cpus=$(sinfo -h -o %C | cut -d/ -f4)
nodes=$(sinfo -h -o %D | head -1)

big=$(sbatch --parsable --job-name=hog --ntasks="$cpus" --wrap='sleep 20')
small=$(sbatch --parsable --job-name=small --ntasks=1 --wrap='hostname')
never=$(sbatch --parsable --job-name=toobig --nodes=$((nodes + 1)) --wrap='true' 2>/dev/null || echo rejected)

echo "== hog $big took all $cpus CPUs; small $small waits; toobig: $never"
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
