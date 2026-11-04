#!/usr/bin/env bash
# A job array: twice as many one-core tasks as the cluster has nodes, each
# sleeping a few seconds. Watch the queue drain in two waves. A task's
# output lands on the worker that ran it: the cluster has no shared
# filesystem, so this demo sends it to /dev/null.
set -euo pipefail

nodes=$(sinfo -h -t idle -o %D | head -1)
jobid=$(sbatch --parsable --array="1-$((nodes * 2))" --cpus-per-task=1 --job-name=array \
  --output=/dev/null \
  --wrap='echo "task $SLURM_ARRAY_TASK_ID on $(hostname)"; sleep 8')
echo "== submitted array job $jobid: $((nodes * 2)) tasks over $nodes nodes"

for _ in $(seq 12); do
  echo "-- $(date +%T)"
  squeue --job "$jobid" -o "%.12i %.8T %.10M %.6D %R" || true
  squeue -h --job "$jobid" | grep -q . || break
  sleep 3
done

echo
echo "== the array is done; each worker holds its own tasks' output"
