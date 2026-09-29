---
title: How Rowbutt works
description: How mate runs Rowbutt's agent loop, leases a sandbox on the offsite cluster for its tools and keeps its sessions, and the credentials and network policy of each part.
---

mate is the process behind [Rowbutt](../mate.md). It runs the agent loop for each thread, runs the agent's tools in the thread's sandbox, and gives each turn short-lived credentials.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| mate | Connects to Discord and Slack, runs the agent loop on pi (`@earendil-works/pi-agent-core`), calls the model, bridges the kthx MCP tools, creates Sandboxes and mints tokens | Deployment `mate` in namespace `mate` |
| Sandbox | One per thread that has run a tool, plus one ready spare. Init container `checkout` clones the repository. mate execs `mate-hands`, the daemon that runs the agent's file and shell calls, in container `harness`. | A pod with runtime class `kata-clh`, a Cloud Hypervisor microVM ([Kubernetes](../../platform/kubernetes.md)), in namespace `mate` on [oldschool](../../hosts/oldschool.md), the offsite worker node |
| [Session store](#session-store) | Postgres that holds pi's sessions and mate's `mate_threads` and `mate_credentials` tables | CloudNativePG `Cluster` `mate-db` in namespace `mate` |

The model is `MATE_MODEL`, on the owner's ChatGPT subscription through pi-ai's `openai-codex` provider, at the reasoning level in `MATE_THINKING`. When ChatGPT cannot answer, `MATE_FALLBACK_MODEL` answers through pi-ai's `opencode-go` provider, at `MATE_FALLBACK_THINKING`. [Model routing](#model-routing) says when. The system prompt is a note about the surface and the sandbox, then `AGENTS.md`, then an index of the skills in `dotfiles/skills/` and `.agents/skills/`. The mate image bakes these files, and the agent reads a skill from the sandbox's checkout.

## A turn

1. The model streams its answer. A turn that calls no tool ends here, and no sandbox exists for it.
2. The first tool call leases the thread's sandbox: its own, else the ready spare, else a new one. mate moves the Sandbox's `spec.shutdownTime` two hours ahead.
3. mate opens one `pods/exec` stream to `mate-hands` with a new epoch, which kills any command an earlier stream left running. It writes the turn's credentials and the kthx sites file, from Secret `mate-kthx-sites`, as files with mode 0600. Every later tool call in the turn uses the same stream.
4. At turn end, mate reads the kthx sites file back into the Secret, empties the credential files, and revokes the GitHub token. It then shuts `mate-hands` down, which ends every process the turn started, and moves `shutdownTime` two hours ahead.

If the sandbox dies mid-turn, the tool call fails, and the next call starts a new sandbox.

## Model routing

A router in `apps/mate/src/route.ts` sends each model request to ChatGPT first. If ChatGPT fails before its first text, reasoning or tool call, the router sends the same request to the fallback in the same step, so pi records no failure. pi retries an error after content. Stop, the turn timeout and a context overflow never go to the fallback.

A breaker that all threads share keeps requests off ChatGPT while it is down:

| Reason | ChatGPT stays off |
| --- | --- |
| `limit`: the usage limit | Until the reset that OpenAI gives, or 5 minutes, doubling to 2 hours |
| `auth`: OpenAI refuses the token or its refresh | Until a new token. The first refused token gets one forced rotation. If chatgpt.com refuses the new token too, mate counts itself signed out. |
| `unconfigured`: no sign-in | Until a sign-in |
| `transient`: a 5xx, a timeout, or `chatgpt.com` out of reach | 1 minute |
| `store`: mate-db cannot be read | 1 minute |
| `rejected`: any other refusal | 15 minutes, doubling to 2 hours |
| `paused`: `chatgpt pause` | Until the pause ends, or `chatgpt resume` |

After the wait, one request tries ChatGPT over SSE, and the other requests stay on the fallback. The breaker is in memory, so a restarted mate tries ChatGPT first. While the fallback answers, the turn's status line starts with ↪️ and names the reason. The first turn of a `limit`, `auth`, `unconfigured` or `rejected` outage ends with one notice.

A request leaves out the other model's reasoning where it sits beside an answer or a tool call. ChatGPT's requests count at $0 in `mate_turn_cost_usd`, so the metric is the fallback's list price. `mate_model_routes_total` counts each request by route and reason, and `mate_model_primary_failures_total` counts each request that ChatGPT itself failed, which `MateModelPrimaryFailing` reads.

## Credentials

| Credential | Where it is | Scope |
| --- | --- | --- |
| Model key | A file in mate's pod, from Secret `mate-opencode`, read on every request | The fallback model's API |
| kthx agent token | mate's environment `KTHX_AGENT_TOKEN`, from Secret `mate-kthx-agent` | Every built-apps command but minting tokens, replacing the engine settings and connecting or probing a Target, for 90 days |
| Database role | mate's environment `DATABASE_URL`, from Secret `mate-db-app` | Owner of database `mate` |
| ChatGPT sign-in | Row `openai-codex` of table `mate_credentials` in mate-db, which mate alone writes and rotates about every eight days | The owner's ChatGPT subscription, through `chatgpt.com/backend-api` |
| GitHub App private key | mate's pod, from Secret `mate-github-app` | Signs token requests |
| GitHub installation token | The file in `$MATE_GITHUB_TOKEN_FILE` | `clanky-bot[bot]` on `jonpulsifer/infra`: contents and pull requests write, actions read |
| Cluster token | `$KUBECONFIG`, with the contexts `offsite` and `folly` | ServiceAccount `mate-sandbox-admin`, `cluster-admin` on both clusters, for `MATE_TURN_MINUTES` plus 5 minutes |
| SSH key | `/home/agent/.ssh/id_ed25519`, from Secret `mate-sandbox-ssh` | `rowbutt` on every host that `github.com/rowbutt.keys` authorizes, with passwordless sudo |
| kthx site bearers | `/home/agent/.config/kthx/sites.json`, from Secret `mate-kthx-sites` | Every quick site Rowbutt claims |
| Ring token | Sandbox environment, from Secret `mate-switchboard`, absent until the `switchboard` 1Password item exists | `POST /ring` on [Switchboard](../switchboard.md), which rings one fixed number |

The model key, the kthx agent token, the database role and the App key stay in mate's pod. The ChatGPT sign-in stays in mate-db, which the sandbox reaches through Secret `mate-db-app`, so the agent can use the owner's ChatGPT account. [Sign Rowbutt in to ChatGPT](../../runbooks/sign-rowbutt-in-to-chatgpt.md#sign-out) has the kill switch. The files in the sandbox exist from the turn's first tool call to its end. The sandbox is `cluster-admin`, so it can still read every Secret in `mate`.

`MATE_CONNECT_SECRET` is unset, so a sandbox has no 1Password token.

The token's audience is `api`. offsite admits it for `mate-sandbox-admin`, and folly admits the same token as `federated:system:serviceaccount:mate:mate-sandbox-admin` through the allow-list in `nix/services/k8s/default.nix`; `clusters/folly/apps/mate-sandbox/` binds that user to `cluster-admin`. mate writes a context for each cluster in `MATE_SANDBOX_KUBE_PEERS` from the sandbox's checkout: the API server in `clusters/<cluster>/config/cluster-topology.json` and the CA in `terraform/pki/certs/<cluster>-ca-bundle.pem`.

The 1Password item `SSH: rowbutt` holds the key as PKCS#8, and `apps/mate/src/ssh-key.ts` rewrites it in OpenSSH format when mate starts. The SSH client config, `SSH_CLIENT_CONFIG` in `apps/mate/src/credentials.ts`, completes a short host name with `lolwtf.ca` and reaches folly's Lab Net hosts through riptide.

mate's Role reads and patches one Secret, `mate-kthx-sites`. `apps/mate/src/kthx-sites.ts` keeps that ledger, and `apps/mate/src/credentials.ts` writes the file into the sandbox and reads it back.

`clanky-bot[bot]` is in `atlantis_users` in `clusters/offsite/apps/atlantis/policies/only-me.rego` and in `atlantis_appliers` in `clusters/offsite/apps/atlantis/policies/appliers.rego`, so its comments can plan and apply.

## Network

| Pod | Egress |
| --- | --- |
| mate | DNS, Discord, Slack, `api.github.com`, `opencode.ai`, `auth.openai.com` and `chatgpt.com` on 443, the API server, the OTLP collector, the `mate-db` instance on 5432, the kthx engine's web pods on 3000 |
| Sandbox | DNS; the internet on 80 and 443; every in-cluster pod but the `mate` namespace and Alertmanager; the API server; offsite's nodes on 22; `CILIUM_NATIVE_ROUTING_CIDR`, which holds folly's hosts and API server, on 22 and 6443. `kthx.lolwtf.ca` on 443 and the kthx engine in `spindrift` pass under these rules: the control host is on the Gateway and the engine is an in-cluster pod. |

The microVM isolates the kernel. mate's ingress admits only the node it runs on. The sandbox's policy keeps it away from `mate` and from Alertmanager, whose API takes an alert from anyone, but as `cluster-admin` and root on the nodes it can reach both on purpose.

No policy selects the `mate-db` instance or the backup Job's pod. The CloudNativePG controller, Prometheus and the kubelet reach the instance, and the Job reaches Google Cloud. A sandbox reaches neither, because its egress leaves out every pod in `mate`.

## Session store

`clusters/offsite/apps/mate/database.yaml` declares `mate-db`, one Postgres instance on a `local-path` volume. Its database and owner role are both `mate`. CloudNativePG writes the role's credentials to Secret `mate-db-app` and its CA to Secret `mate-db-ca`, and mate connects with `sslmode=verify-full` against that CA. Flux never prunes the `Cluster`, because CloudNativePG deletes the volume with it; removing the store is a deliberate delete.

`packages/pi-store-postgres/` keeps pi's sessions in tables prefixed `pi_`. mate keeps a row per thread in `mate_threads`: its session id, its sandbox and the turn in flight, so a restarted mate finds every open thread. `mate_credentials` holds the ChatGPT sign-in, and mate is its only writer. A credential that mate cannot save stays in memory, and mate retries the write every 30 seconds. mate deletes the session of a thread closed for more than `MATE_SESSION_RETENTION_DAYS`, 14 by default. If the store is down, mate stays connected and tells each thread that it cannot reach its memory.

CronJob `mate-db-backup`, in `database-backup.yaml` beside it, writes a gzipped `pg_dump` to `gs://homelab-ng-mate/backups/pg/` at 04:43 UTC. The dump leaves out the rows of `mate_credentials`, so a restore needs a new ChatGPT sign-in. It signs in to Google Cloud as `mate-db-backup@homelab-ng` through workload identity federation, with no key. `terraform/gcp/projects/homelab-ng/mate.tf` declares that account and the bucket, which deletes a dump after 30 days. There is no WAL archive, so a restore loses every write after the last dump.

## Fence

A `ValidatingAdmissionPolicy` in `clusters/offsite/apps/mate/fence/` denies `mate-sandbox-admin` any `pods/exec`, `pods/attach` or `pods/portforward` into `mate`, which holds mate's credentials and every thread's sandbox. The sandbox's network policy also excludes `mate` from its in-cluster egress. Both guard against accidents, not intent: the sandbox is `cluster-admin`, so it can read mate's Secrets or delete the policy.

## Rules

- Keep one replica with `strategy: Recreate`. Two pods on Discord both reply, two on Slack each get half the events, and both write each thread's session.
- Run no second mate against `mate-db`, such as a local run with its `DATABASE_URL`. Both would refresh the one ChatGPT token, and OpenAI refuses a refresh token spent twice.
- Keep the probe readiness-only. `/healthz` returns 503 while mate waits for Discord's session start limit, so a liveness probe restarts mate and spends more of it.
- Keep `MATE_TURN_MINUTES` under 55, or mate does not start.
- Keep `MATE_MAX_SANDBOXES` plus `MATE_SPARES` sandboxes within oldschool's free CPU. Each sandbox requests 500m, and one that does not fit stays `Pending`.
- Keep `terminationGracePeriodSeconds` at 45 or more. On SIGTERM mate lets running turns finish, then closes the rest, and the next pod resumes each one in a new message. A resumed command returns as interrupted, with its outcome unknown.
- Expect background processes to end with the turn, because mate shuts `mate-hands` down at turn end.
- Bump `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` together, while no turn runs: `mate-db` holds sessions in pi's format, and the new version resumes any open run.

## Where it lives

- `apps/mate/src/brain.ts`: the agent loop, one pi harness per open thread
- `apps/mate/src/sandbox-lease.ts`: a turn's lease on its sandbox, and the sandbox cap
- `apps/mate/src/hands-env.ts`: pi's execution environment over the `mate-hands` stream
- `apps/mate/src/credentials.ts`: the credential files of a turn
- `apps/mate/src/sandboxes.ts`: the Sandbox, its manifest and the spare pool
- `apps/mate/src/store.ts`: the connection to `mate-db` and the `mate_threads` table
- `apps/mate/src/credential-store.ts`: the `mate_credentials` table
- `apps/mate/src/chatgpt.ts`: the ChatGPT sign-in, the `chatgpt` commands and the keeper that refreshes the token
- `apps/mate/src/route.ts`: the router between ChatGPT and the fallback, and its breaker
- `apps/mate/src/profile.ts`: the system prompt
- `apps/mate/src/mcp.ts`: the kthx MCP bridge
- `apps/mate/src/kthx-sites.ts`: the ledger of kthx site bearers
- `packages/pi-store-postgres/`: pi's session storage on Postgres
- `packages/mate-hands/`: the `mate-hands` daemon, and the protocol that `apps/mate/src/hands.ts` speaks to it
- `images/mate-sandbox/Dockerfile`: the sandbox image
- `clusters/offsite/apps/mate/database.yaml`: the session store
- `clusters/offsite/monitoring/mate-rules.yaml`: alerts, tested by `mise run k8s:check-rules`
- `.github/containers.json`: the CD entries for both images
