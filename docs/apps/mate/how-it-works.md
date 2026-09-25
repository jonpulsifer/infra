---
title: How Rowbutt works
description: How mate runs each Rowbutt thread in a sandbox on the offsite cluster, and the credentials and network policy of each part.
---

mate is the process behind [Rowbutt](../mate.md). It runs each thread in a sandbox and gives each turn short-lived credentials.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| mate | Connects to Discord and Slack, runs threads, creates Sandboxes and mints tokens | Deployment `mate` in namespace `mate` |
| Sandbox | One per thread, plus one ready spare. Init container `checkout` clones the repository, and container `harness` runs OpenCode. | A pod with runtime class `kata-clh`, a Cloud Hypervisor microVM ([Kubernetes](../../platform/kubernetes.md)), in namespace `mate` on [oldschool](../../hosts/oldschool.md), the offsite worker node |

## A turn

1. mate moves the Sandbox's `spec.shutdownTime` two hours ahead and sets the annotation `lolwtf.ca/turn-started`.
2. mate mints the credentials and writes them into the pod with one `pods/exec`.
3. mate sends the prompt to OpenCode over ACP (Agent Client Protocol) and streams the answer.
4. mate empties the credential files, revokes the GitHub token, moves `shutdownTime` two hours ahead and removes the annotation.

## Credentials

| Credential | Where it is | Scope |
| --- | --- | --- |
| GitHub App private key | mate's pod, from Secret `mate-github-app` | Signs token requests |
| GitHub installation token | The file in `$MATE_GITHUB_TOKEN_FILE` | `clanky-bot[bot]` on `jonpulsifer/infra`: contents and pull requests write, actions read |
| Cluster token | `$KUBECONFIG` | ServiceAccount `mate-sandbox-debug`, for `MATE_TURN_MINUTES` plus 5 minutes |
| OpenCode key | Sandbox environment, from Secret `mate-opencode` | The model API |

`MATE_SSH_KEY_FILE` and `MATE_CONNECT_SECRET` are unset, so a sandbox has no SSH key and no 1Password token.

`clanky-bot[bot]` is in `atlantis_users` in `clusters/offsite/apps/atlantis/policies/only-me.rego`, so its comments can plan.

## Network

| Pod | Egress |
| --- | --- |
| mate | DNS, Discord, Slack, `api.github.com`, the API server, the OTLP collector |
| Sandbox | DNS; `opencode.ai`, `models.opencode.ai`, `github.com` and `api.github.com` on 443; every in-cluster pod but the `mate` namespace; the API server; `CILIUM_NATIVE_ROUTING_CIDR` on 22 and 6443 |

The microVM isolates the kernel, and the network policy is the only network boundary. mate's ingress admits only the node it runs on.

## Fence

A `ValidatingAdmissionPolicy` in `clusters/offsite/apps/mate/fence/` denies `mate-sandbox-debug` any `pods/exec`, `pods/attach` or `pods/portforward` into `mate` or into a namespace labelled `lolwtf.ca/sandbox-exec: deny`. The sandbox's network policy also excludes `mate` from its in-cluster egress. The label marks a namespace where exec leads to escalation: a ServiceAccount that reads Secrets beyond its namespace or otherwise escalates, a credential that does, or a privileged or host-level pod. A new namespace like that needs the label too. A namespace with no Namespace manifest in this repo, such as `kube-system`, is named directly in the policy instead. A ServiceAccount that can patch Namespaces, such as spindrift's, can still remove the label from a fenced namespace.

## Rules

- Keep one replica with `strategy: Recreate`. Two pods on Discord both reply, and two on Slack each get half the events.
- Keep the probe readiness-only. `/healthz` returns 503 while mate waits for Discord's session start limit, so a liveness probe restarts mate and spends more of it.
- Keep `MATE_TURN_MINUTES` under 55, or mate does not start.
- Keep `MATE_MAX_CONCURRENT` plus `MATE_SPARES` sandboxes within oldschool's free CPU. Each sandbox requests 500m, and one that does not fit stays `Pending`.

## Where it lives

- `apps/mate/src/sandboxes.ts`: the Sandbox and the credential writes
- `images/mate-sandbox/Dockerfile`: the harness image
- `clusters/offsite/monitoring/mate-rules.yaml`: alerts, tested by `mise run k8s:check-rules`
- `.github/containers.json`: the CD entries for both images
