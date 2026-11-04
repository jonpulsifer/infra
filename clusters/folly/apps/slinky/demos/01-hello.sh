#!/usr/bin/env bash
# One task on every node, then two tasks on two nodes, with srun.
# Each line names the Kubernetes node under the slurmd pod that ran it.
set -euo pipefail

nodes=$(sinfo -h -t idle -o %D | head -1)

echo "== one task on each of the $nodes idle nodes"
srun --nodes="$nodes" --ntasks-per-node=1 --label --time=1 \
  bash -c 'echo "$(hostname) on ${SLURMD_NODENAME:-?}, cpus $(nproc)"'

echo
echo "== two tasks on two nodes, each with one CPU"
srun --nodes=2 --ntasks=2 --label --time=1 bash -c 'echo "task $SLURM_PROCID of $SLURM_NTASKS on $(hostname)"'

echo
echo "== the job records the scheduler kept"
squeue --me --states=all -o "%.8i %.9P %.12j %.8T %.10M %.6D %R" | head
