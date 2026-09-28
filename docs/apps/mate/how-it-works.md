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
| [Session store](#session-store) | Postgres reserved for mate's session state. Nothing connects to it yet. | CloudNativePG `Cluster` `mate-db` in namespace `mate` |

The sandbox image also carries `mate-hands`, a daemon that runs file and shell calls sent over one `pods/exec` stream. mate does not use it yet.

## A turn

1. mate moves the Sandbox's `spec.shutdownTime` two hours ahead and sets the annotation `lolwtf.ca/turn-started`.
2. mate mints the credentials and writes them, with the kthx sites file from Secret `mate-kthx-sites`, into the pod with one `pods/exec`.
3. mate sends the prompt to OpenCode over ACP (Agent Client Protocol) and streams the answer.
4. mate reads the kthx sites file back into the Secret, empties the credential files, revokes the GitHub token, moves `shutdownTime` two hours ahead and removes the annotation.

## Credentials

| Credential | Where it is | Scope |
| --- | --- | --- |
| GitHub App private key | mate's pod, from Secret `mate-github-app` | Signs token requests |
| GitHub installation token | The file in `$MATE_GITHUB_TOKEN_FILE` | `clanky-bot[bot]` on `jonpulsifer/infra`: contents and pull requests write, actions read |
| Cluster token | `$KUBECONFIG`, with the contexts `offsite` and `folly` | ServiceAccount `mate-sandbox-admin`, `cluster-admin` on both clusters, for `MATE_TURN_MINUTES` plus 5 minutes |
| SSH key | `/home/agent/.ssh/id_ed25519`, from Secret `mate-sandbox-ssh` | `rowbutt` on every host that `github.com/rowbutt.keys` authorizes, with passwordless sudo |
| OpenCode key | Sandbox environment, from Secret `mate-opencode` | The model API |
| kthx site bearers | `/home/agent/.config/kthx/sites.json`, from Secret `mate-kthx-sites` | Every quick site Rowbutt claims |
| kthx agent token | Sandbox environment `KTHX_AGENT_TOKEN`, from Secret `mate-kthx-agent` | Every built-apps command but minting tokens, replacing the engine settings and connecting or probing a Target, for 90 days |
| Ring token | Sandbox environment, from Secret `mate-switchboard`, absent until the `switchboard` 1Password item exists | `POST /ring` on [Switchboard](../switchboard.md), which rings one fixed number |

`MATE_CONNECT_SECRET` is unset, so a sandbox has no 1Password token.

The token's audience is `api`. offsite admits it for `mate-sandbox-admin`, and folly admits the same token as `federated:system:serviceaccount:mate:mate-sandbox-admin` through the allow-list in `nix/services/k8s/default.nix`; `clusters/folly/apps/mate-sandbox/` binds that user to `cluster-admin`. mate writes a context for each cluster in `MATE_SANDBOX_KUBE_PEERS` from the sandbox's checkout: the API server in `clusters/<cluster>/config/cluster-topology.json` and the CA in `terraform/pki/certs/<cluster>-ca-bundle.pem`.

The 1Password item `SSH: rowbutt` holds the key as PKCS#8, and `apps/mate/src/ssh-key.ts` rewrites it in OpenSSH format when mate starts. The SSH client config, `SSH_CLIENT_CONFIG` in `apps/mate/src/sandboxes.ts`, completes a short host name with `lolwtf.ca` and reaches folly's Lab Net hosts through riptide.

mate's Role reads and patches one Secret, `mate-kthx-sites`. `apps/mate/src/kthx-sites.ts` is the ledger that writes the file into the sandbox and reads it back.

`clanky-bot[bot]` is in `atlantis_users` in `clusters/offsite/apps/atlantis/policies/only-me.rego` and in `atlantis_appliers` in `clusters/offsite/apps/atlantis/policies/appliers.rego`, so its comments can plan and apply.

## Network

| Pod | Egress |
| --- | --- |
| mate | DNS, Discord, Slack, `api.github.com`, the API server, the OTLP collector, the `mate-db` instance on 5432 |
| Sandbox | DNS; the internet on 80 and 443; every in-cluster pod but the `mate` namespace and Alertmanager; the API server; offsite's nodes on 22; `CILIUM_NATIVE_ROUTING_CIDR`, which holds folly's hosts and API server, on 22 and 6443. `kthx.lolwtf.ca` on 443 and the kthx engine in `spindrift` pass under these rules: the control host is on the Gateway and the engine is an in-cluster pod. |

The microVM isolates the kernel. mate's ingress admits only the node it runs on. The sandbox's policy keeps it away from `mate` and from Alertmanager, whose API takes an alert from anyone, but as `cluster-admin` and root on the nodes it can reach both on purpose.

No policy selects the `mate-db` instance or the backup Job's pod. The CloudNativePG controller, Prometheus and the kubelet reach the instance, and the Job reaches Google Cloud. A sandbox reaches neither, because its egress leaves out every pod in `mate`.

## Session store

`clusters/offsite/apps/mate/database.yaml` declares `mate-db`, one Postgres instance on a `local-path` volume. Its database and owner role are both `mate`, and CloudNativePG writes the role's credentials to Secret `mate-db-app`. Flux never prunes the `Cluster`, because CloudNativePG deletes the volume with it; removing the store is a deliberate delete.

CronJob `mate-db-backup`, in `database-backup.yaml` beside it, writes a gzipped `pg_dump` to `gs://homelab-ng-mate/backups/pg/` at 04:43 UTC. It signs in to Google Cloud as `mate-db-backup@homelab-ng` through workload identity federation, with no key. `terraform/gcp/projects/homelab-ng/mate.tf` declares that account and the bucket, which deletes a dump after 30 days. There is no WAL archive, so a restore loses every write after the last dump.

## Fence

A `ValidatingAdmissionPolicy` in `clusters/offsite/apps/mate/fence/` denies `mate-sandbox-admin` any `pods/exec`, `pods/attach` or `pods/portforward` into `mate`, which holds mate's credentials and every thread's sandbox. The sandbox's network policy also excludes `mate` from its in-cluster egress. Both guard against accidents, not intent: the sandbox is `cluster-admin`, so it can read mate's Secrets or delete the policy.

## Rules

- Keep one replica with `strategy: Recreate`. Two pods on Discord both reply, and two on Slack each get half the events.
- Keep the probe readiness-only. `/healthz` returns 503 while mate waits for Discord's session start limit, so a liveness probe restarts mate and spends more of it.
- Keep `MATE_TURN_MINUTES` under 55, or mate does not start.
- Keep `MATE_MAX_CONCURRENT` plus `MATE_SPARES` sandboxes within oldschool's free CPU. Each sandbox requests 500m, and one that does not fit stays `Pending`.

## Where it lives

- `apps/mate/src/sandboxes.ts`: the Sandbox and the credential writes
- `apps/mate/src/kthx-sites.ts`: the ledger of kthx site bearers
- `images/mate-sandbox/Dockerfile`: the harness image
- `clusters/offsite/apps/mate/database.yaml`: the session store
- `packages/mate-hands/`: the `mate-hands` daemon, and the protocol that `apps/mate/src/hands.ts` speaks to it
- `clusters/offsite/monitoring/mate-rules.yaml`: alerts, tested by `mise run k8s:check-rules`
- `.github/containers.json`: the CD entries for both images
