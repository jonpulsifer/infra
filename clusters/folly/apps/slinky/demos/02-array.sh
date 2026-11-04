#!/usr/bin/env bash
# A job array: twice as many one-CPU tasks as the cluster has idle CPUs,
# each sleeping a few seconds. Watch the queue drain in two waves.
set -euo pipefail

out=/tmp/demo-array
mkdir -p "$out"
rm -f "$out"/*.out

cpus=$(sinfo -h -o %C | cut -d/ -f2)
jobid=$(sbatch --parsable --array="1-$((cpus * 2))" --cpus-per-task=1 --job-name=array \
  --output="$out/%A_%a.out" \
  --wrap='echo "task $SLURM_ARRAY_TASK_ID on $(hostname)"; sleep 8')
echo "== submitted array job $jobid: $((cpus * 2)) tasks over $cpus CPUs"

for _ in $(seq 12); do
  echo "-- $(date +%T)"
  squeue --job "$jobid" -o "%.12i %.8T %.10M %.6D %R" || true
  squeue -h --job "$jobid" | grep -q . || break
  sleep 3
done

echo
echo "== output, one file per task"
cat "$out"/*.out
