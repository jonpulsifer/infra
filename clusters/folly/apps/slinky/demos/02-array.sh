#!/usr/bin/env bash
# A job array: twice as many one-core tasks as the cluster has nodes, each
# sleeping a few seconds. Watch the queue drain in two waves. Each task
# writes to /shared, the NFS scratch every worker and the login pod mount,
# so the output is readable here when the array ends.
set -euo pipefail

nodes=$(sinfo -h -t idle -o %D | head -1)
[ "${nodes:-0}" -gt 0 ] || {
  echo "no idle node; sinfo says:"
  sinfo
  exit 1
}
dir=/shared/demo-array
mkdir -p "$dir"
rm -f "$dir"/*.out

# shellcheck disable=SC2016 # Slurm expands the variables on the worker.
jobid=$(sbatch --parsable --array="1-$((nodes * 2))" --cpus-per-task=1 --job-name=array \
  --output="$dir/%A_%a.out" \
  --wrap='echo "task $SLURM_ARRAY_TASK_ID ran on $(hostname) at $(date +%T)"; sleep 8')
echo "== submitted array job $jobid: $((nodes * 2)) tasks over $nodes nodes"

for _ in $(seq 12); do
  echo "-- $(date +%T)"
  squeue --job "$jobid" -o "%.12i %.8T %.10M %.6D %R" || true
  squeue -h --job "$jobid" | grep -q . || break
  sleep 3
done

echo
echo "== every task's output, from $dir"
cat "$dir"/*.out
