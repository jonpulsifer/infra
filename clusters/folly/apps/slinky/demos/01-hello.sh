#!/usr/bin/env bash
# One task on every node, then one task per CPU on one node, with srun.
# Each line names the Kubernetes node under the slurmd pod that ran it.
set -euo pipefail

nodes=$(sinfo -h -o %D | head -1)

echo "== one task on each of the $nodes nodes"
srun --nodes="$nodes" --ntasks-per-node=1 --label \
  bash -c 'echo "$(hostname) on ${SLURMD_NODENAME:-?}, cpus $(nproc)"'

echo
echo "== one task per CPU on a single node"
srun --nodes=1 --ntasks=2 --label bash -c 'echo "task $SLURM_PROCID of $SLURM_NTASKS on $(hostname)"'

echo
echo "== the job records the scheduler kept"
squeue --me --states=all -o "%.8i %.9P %.12j %.8T %.10M %.6D %R" | head
