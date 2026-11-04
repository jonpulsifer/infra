---
title: Run a Slurm demo
description: Reach the Slinky login pod on folly, run the demo scripts, drain and resume a worker, and call the REST API from outside the cluster.
---

Use this runbook to show Slurm at work on folly. [Slinky](../apps/slinky.md) describes what runs. Each demo prints what it does and leaves the cluster idle when it ends.

## Before you start

- Get `kubectl` access to folly, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Make sure the cluster is up.

  ```bash
  kubectl --context folly -n slurm get pods
  ```

  Result: `slurm-controller-0`, a `slurm-restapi` pod, a `slurm-login-folly` pod and `slurm-worker-folly-0` to `-5` are `Running`.

## Reach the login pod

1. Read the login Service's address.

   ```bash
   kubectl --context folly -n slurm get svc slurm-login-folly
   ```

2. Open a shell as root with one of the owner's GitHub keys.

   ```bash
   ssh root@<EXTERNAL-IP>
   ```

   Without the key, exec into the pod instead.

   ```bash
   kubectl --context folly -n slurm exec -it deploy/slurm-login-folly -- bash
   ```

## Run the demos

Run them in order. Each one is a shell script under `/opt/demos`.

| Script | Shows |
| --- | --- |
| `00-tour.sh` | The partition, each node's CPUs and memory, and the scheduler's statistics |
| `01-hello.sh` | `srun` placing one task on every node, then two tasks on two nodes |
| `02-array.sh` | A job array of twice the cluster's CPUs draining in two waves |
| `03-queue.sh` | A job that takes every CPU, a small job waiting with reason `Resources`, and a job that can never run |
| `04-rest.sh` | `slurmrestd` with a JWT from `scontrol token`: ping, list the nodes, submit a job |

```bash
/opt/demos/00-tour.sh
```

## Drain and resume a worker

1. Drain one node. Slurm finishes its running jobs and places no new one there.

   ```bash
   scontrol update nodename=folly-0 state=drain reason=demo
   sinfo
   ```

2. Submit a job that needs every node, and watch it wait.

   ```bash
   sbatch --nodes=6 --wrap=hostname
   squeue
   ```

3. Resume the node, and watch the job run.

   ```bash
   scontrol update nodename=folly-0 state=resume
   squeue
   ```

## Call the REST API from a workstation

1. Read root's JWT, which the operator refreshes from the `Token` named `root`.

   ```bash
   token=$(kubectl --context folly -n slurm get secret slurm-token-root -o jsonpath='{.data.token}' | base64 -d)
   ```

2. Forward the REST port and call it.

   ```bash
   kubectl --context folly -n slurm port-forward svc/slurm-restapi 6820:6820 &
   curl -H "X-SLURM-USER-NAME: root" -H "X-SLURM-USER-TOKEN: $token" http://localhost:6820/slurm/v0.0.44/ping
   ```

## Change the cluster

The worker count, the CPUs and memory of a worker, and the login keys are values in `clusters/folly/apps/slinky/helm-release-slurm.yaml`. Change them in a pull request, as [Apply a Kubernetes change](apply-a-kubernetes-change.md) describes. A `kubectl scale nodeset` by hand lasts only until Flux's next Helm upgrade.
