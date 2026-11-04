#!/usr/bin/env bash
# The cluster at a glance: the partition, each node and what the scheduler
# has done so far. Run it first, and again after each other demo.
set -euo pipefail

echo "== partitions"
sinfo

echo
echo "== nodes, with the CPUs and memory each slurmd offers"
sinfo -N -o "%N %T %c %m %e %f"

echo
echo "== the controller's view of one node"
scontrol show node "$(sinfo -N -h -o %N | head -1)"

echo
echo "== scheduler statistics"
sdiag | sed -n '1,25p'
