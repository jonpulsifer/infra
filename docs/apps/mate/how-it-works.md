---
title: How Rowbutt works
description: How mate runs Rowbutt's agent loop, leases a sandbox on the offsite cluster for its tools and keeps its sessions, and the credentials and network policy of each part.
---

mate is the process behind [Rowbutt](../mate.md). It runs the agent loop for each thread, runs the agent's tools in the thread's sandbox, and gives each turn short-lived credentials.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| mate | Connects to Discord and Slack, runs the agent loop on pi (`@earendil-works/pi-durable`), calls the model, bridges the kthx MCP tools, creates Sandboxes and mints tokens | Deployment `mate` in namespace `mate` |
| Sandbox | One per thread that has run a tool, plus one ready spare. Init container `checkout` clones the repository. mate execs `mate-hands`, the daemon that runs the agent's file and shell calls, in container `harness`. | A pod with runtime class `kata-clh`, a Cloud Hypervisor microVM ([Kubernetes](../../platform/kubernetes.md)), in namespace `mate` on [oldschool](../../hosts/oldschool.md), the offsite worker node |
| [Session store](#session-store) | Postgres that holds pi's sessions and mate's `mate_threads`, `mate_profile_turns`, `mate_credentials` and `mate_slack_events` tables | CloudNativePG `Cluster` `mate-db` in namespace `mate` |

The model is `MATE_MODEL`, on the owner's ChatGPT subscription through pi-ai's `openai-codex` provider, at the reasoning level in `MATE_THINKING`. When ChatGPT cannot answer, `MATE_FALLBACK_MODEL` answers through pi-ai's `opencode-go` provider, at `MATE_FALLBACK_THINKING`. [Model routing](#model-routing) says when. The system prompt is the persona in `dotfiles/pi/mate/persona.md`, the profile's note about the surface and the sandbox, the owner's global `dotfiles/.agents/AGENTS.md`, the profile's overrides of those rules, `AGENTS.md`, then an index of the skills in `dotfiles/skills/` and `.agents/skills/`. The investigator reads only the Protect and Communicate sections of the global file. `profiles.ts` builds the overrides from the profile's grants that mate's config backs: the GitHub App, 1Password Connect and the sandbox ServiceAccounts. They claim no access that the sandbox does not hold. The owner's local pi reads the same persona through the `mate` pi package in `dotfiles/pi/mate/`. The mate image bakes these files, and the agent reads a skill from the sandbox's checkout.

## Profiles

`apps/mate/src/profiles.ts` declares each profile's mode, system prompt note, model, tools, credentials, sandbox network and budget. [Rowbutt](../mate.md#profiles) lists them.

Each row in `mate_threads` names its profile in column `profile`. mate writes it when the row is born and never changes it; a row with no profile runs as `operator`. A message that starts with `+<profile>` asks for that profile: on a new thread it sets the row's, and in a known thread it must match. Only `Threads.start`, the trusted trigger the custodian uses, opens an automation or job thread. A row naming a profile this mate does not declare opens nothing, and its thread says so.

Interactive profiles share `MATE_MAX_CONCURRENT` turns and the in-memory window of `MATE_MAX_TURNS_PER_DAY`. Automation and job profiles share a second lane of one turn, and each counts its own daily cap in `mate_profile_turns`, by UTC day. An owner reply in an automation or job thread runs in that lane. `mate_turns_running`, `mate_queue_depth` and `mate_sandbox_waiters` carry a `lane` label, and `mate_turns_total` carries `profile` and `mode`. In the sandbox cap, an interactive waiter goes ahead of an automation one, and an automation waiter never takes an interactive thread's sandbox. A job thread releases its sandbox with reason `finished` and archives itself when its turn ends.

Every sandbox carries `lolwtf.ca/profile`, and serves one profile: a thread condemns a sandbox labelled for another profile and mints a new one. A sandbox on the `mate-sandbox-reader` network also carries `lolwtf.ca/minted-by=mate-reader`, and its name ends in `-r`, so an image from before profiles never lists or reuses it. Spares are `operator` pods, and only `operator` adopts one.

Retention deletes the closed rows of profiles whose grants equal `operator`'s, as `sweepable` in `profiles.ts` lists them. A deleted row is born again as `operator` at the next mention in its thread, so mate keeps every `investigator` row.

## Daily custodian

`apps/mate/src/custodian.ts` checks the local date and hour in `America/Halifax` every minute. When it is 18:00 or later, `mate_custodian_runs` claims the calendar day, posts a Slack root in the configured channel, saves its timestamp and calls `Threads.start` with the `custodian` profile and the owner as the asker. `start` writes the thread's row, posts the assignment as `📋 assignment` so a replayed session still has it, and queues the turn. The row is the attempt: once it exists, `start` does nothing, so a refused or failed first turn is said once in the thread, and a reply runs it again. An open job row that a restart finds with no turn run says so in its thread. The turn runs in the automation lane with operator's credentials, and the thread releases its sandbox when the report is done. The daily assignment can fix clear issues through branches and PRs, and merge understood PRs after required checks and reviews pass. It follows `AGENTS.md` for GitOps and escalates risky or unclear changes. A failed database or Slack call before the row exists retries while the same Atlantic day remains. A crash between Slack's post and the timestamp write may leave a duplicate root; investigate a missing or duplicate report in mate's logs and Slack.

## Inbound messages

mate reads only the allowlist's messages. A mention in an allowed channel opens a thread. A reply in a thread with a row in `mate_threads` continues it, whether the row is open, closed for quiet or finished, and across restarts. It runs under the row's profile with its stored session, so a reply to the custodian's report runs as `custodian` in the automation lane.

Slack retries an undelivered event for about six minutes. mate claims each event id in `mate_slack_events` before it answers, so a retry after a restart is answered once, and an event older than an hour is not. While the store is down, the cutoff is the process start.

mate downloads no file on a message. The prompt ends with a line naming each file, with its type and size.

`mate_inbound_dropped_total` counts an allowlisted message that runs nothing and says nothing, by `surface` and `reason`: `no-mention`, `channel`, `thread-create`, `stale` or `subtype`. The log line `an inbound message was ignored` carries its ids, never its text.

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
| `auth`: OpenAI refuses the token or its refresh | Until a new token. The first refused token gets one forced rotation, which mate tries again every 15 minutes while auth.openai.com or mate-db fails it. If chatgpt.com refuses the new token too, mate counts itself signed out. |
| `unconfigured`: no sign-in | Until a sign-in |
| `transient`: a 5xx, a timeout, or `chatgpt.com` out of reach | 1 minute |
| `store`: mate-db cannot be read | 1 minute |
| `rejected`: any other refusal | 15 minutes, doubling to 2 hours |
| `paused`: `chatgpt pause` | Until the pause ends, `chatgpt resume`, or a restart of mate |

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
| Cluster token (read-only) | `$KUBECONFIG`, with the contexts `offsite` and `folly` | ServiceAccount `mate-sandbox-reader`: `view` plus `clusters/base/apps/mate-sandbox-reader/` on both clusters, and GET on Prometheus and Alertmanager through the API server's service proxy (`clusters/base/monitoring/mate-sandbox-reader.yaml`), for 20 minutes plus 5 |
| SSH key | `/home/agent/.ssh/id_ed25519`, from Secret `mate-sandbox-ssh` | `rowbutt` on every host that `github.com/rowbutt.keys` authorizes, with passwordless sudo |
| talosconfig | `/home/agent/.talos/config`, from Secret `mate-sandbox-talos`, absent until the `talos-rowbutt-reader` 1Password item exists | `os:reader` on the Talos API of each cluster's nodes, which reads no file contents and changes nothing. mate refuses a file with another role. |
| kthx site bearers | `/home/agent/.config/kthx/sites.json`, from Secret `mate-kthx-sites` | Every quick site Rowbutt claims |
| Ring token | Sandbox environment, from Secret `mate-switchboard`, absent until the `switchboard` 1Password item exists | `POST /ring` on [Switchboard](../switchboard.md), which rings one fixed number |

The model key, the kthx agent token, the database role and the App key stay in mate's pod. mate reads and refreshes the ChatGPT sign-in only while `MATE_MODEL` is a ChatGPT model and mate-db has a URL and a CA. The ChatGPT sign-in stays in mate-db, which an operator sandbox reaches through Secret `mate-db-app`, so the agent can use the owner's ChatGPT account. [Sign Rowbutt in to ChatGPT](../../runbooks/sign-rowbutt-in-to-chatgpt.md#sign-out) has the kill switch. The files in the sandbox exist from the turn's first tool call to its end. An operator sandbox is `cluster-admin`, so it can still read every Secret in `mate`.

`MATE_CONNECT_SECRET` is unset, so a sandbox has no 1Password token. A read-only sandbox gets no GitHub token, SSH key, talosconfig, kthx sites file, ring token or Connect token.

The token's audience is `api`. offsite admits it for `mate-sandbox-admin` and `mate-sandbox-reader`, and folly admits the same token as `federated:system:serviceaccount:mate:<account>` through the allow-list in `nix/services/k8s/default.nix`. `clusters/folly/apps/mate-sandbox/` binds the admin user to `cluster-admin` and the reader user to `view` and `mate-sandbox-reader`, and `clusters/folly/monitoring/mate-sandbox-reader.yaml` gives the reader user its proxy GET. mate writes a context for each cluster in `MATE_SANDBOX_KUBE_PEERS` from the sandbox's checkout: the API server in `clusters/<cluster>/config/cluster-topology.json` and the CA in `terraform/pki/certs/<cluster>-ca-bundle.pem`.

The 1Password item `SSH: rowbutt` holds the key as PKCS#8, and `apps/mate/src/ssh-key.ts` rewrites it in OpenSSH format when mate starts. The SSH client config, `sshClientConfig` in `apps/mate/src/credentials.ts`, completes a short host name with `lolwtf.ca` and reaches folly's Lab Net hosts through `MATE_SANDBOX_LAB_JUMP`. The Deployment sets riptide, a folly node, because offsite has no route to Lab Net. mate's default, capsule, needs that route and a folly firewall policy that admits the sandbox on its port 22.

mate's Role reads and patches one Secret, `mate-kthx-sites`. `apps/mate/src/kthx-sites.ts` keeps that ledger, and `apps/mate/src/credentials.ts` writes the file into the sandbox and reads it back.

`clanky-bot[bot]` is in `atlantis_users` in `clusters/offsite/apps/atlantis/policies/only-me.rego` and in `atlantis_appliers` in `clusters/offsite/apps/atlantis/policies/appliers.rego`, so its comments can plan and apply.

## Network

| Pod | Egress |
| --- | --- |
| mate | DNS, Discord, Slack, `api.github.com`, `opencode.ai`, `auth.openai.com` and `chatgpt.com` on 443, the API server, the OTLP collector, the `mate-db` instance on 5432, the kthx engine's web pods on 3000, the weather MCP server's pods on 8080 |
| Sandbox | DNS; the internet on 80 and 443; every in-cluster pod but the `mate` namespace and Alertmanager; the API server; offsite's nodes on 22; `CILIUM_NATIVE_ROUTING_CIDR`, which holds folly's hosts and API server, on 22 and 6443. `kthx.lolwtf.ca` on 443 and the kthx engine in `spindrift` pass under these rules: the control host is on the Gateway and the engine is an in-cluster pod. |
| Read-only sandbox | DNS for `cluster.local`, folly's API server name and `github.com`; this cluster's API server, and folly's by name, on 6443; `github.com` on 443 only while `lolwtf.ca/checkout=open`, which mate closes before the agent's first command |

`sandbox-network-policy.yaml` declares the sandbox policy and `mate-sandbox-baseline`, which selects every pod with `lolwtf.ca/hands` and allows DNS for `cluster.local` alone. A sandbox whose own policy is missing gets that egress and no more. `sandbox-reader-network-policy.yaml` declares the read-only policy and the checkout window. Before the agent's first command, mate sets the pod's `lolwtf.ca/checkout` to `closed` and waits for its CiliumEndpoint to carry the new label.

The microVM isolates the kernel. mate's ingress admits only the node it runs on. The sandbox's policy keeps it away from `mate` and from Alertmanager, whose API takes an alert from anyone, but as `cluster-admin` and root on the nodes it can reach both on purpose.

No policy selects the `mate-db` instance or the `mate-db-backup` Job's pod. The CloudNativePG controller, Prometheus and the kubelet reach the instance, and that Job reaches Google Cloud. A sandbox reaches neither, because its egress leaves out every pod in `mate`.

## Session store

`clusters/offsite/apps/mate/database.yaml` declares `mate-db`, one Postgres instance on a `local-path` volume. Its database and owner role are both `mate`. CloudNativePG writes the role's credentials to Secret `mate-db-app` and its CA to Secret `mate-db-ca`, and mate connects with `sslmode=verify-full` against that CA. Flux never prunes the `Cluster`, because CloudNativePG deletes the volume with it; removing the store is a deliberate delete.

`packages/pi-store-postgres/` keeps pi's sessions in tables prefixed `pi_`. mate keeps a row per thread in `mate_threads`: its session id, its sandbox and the turn in flight, so a restarted mate finds every open thread and continues a closed one at its next reply. `mate_slack_events` holds the Slack event ids answered in the last day. `mate_profile_turns` counts each automation and job profile's turns per UTC day. `mate_credentials` holds the ChatGPT sign-in, and mate is its only writer. A credential that mate cannot save stays in memory, and mate retries the write every 30 seconds. mate deletes the session of a thread closed for more than `MATE_SESSION_RETENTION_DAYS`, 14 by default. If the store is down, mate stays connected and tells each thread that it cannot reach its memory.

CronJob `mate-db-backup`, in `database-backup.yaml` beside it, writes a gzipped `pg_dump` to `gs://homelab-ng-mate/backups/pg/` at 04:43 UTC. The dump leaves out the rows of `mate_credentials`, so a restore needs a new ChatGPT sign-in. It signs in to Google Cloud as `mate-db-backup@homelab-ng` through workload identity federation, with no key. `terraform/gcp/projects/homelab-ng/mate.tf` declares that account and the bucket, which deletes a dump after 30 days. `mate-db` has no barman-cloud `ObjectStore`, because a base backup cannot leave out the credential rows.

## Fence

A `ValidatingAdmissionPolicy` in `clusters/offsite/apps/mate/fence/` denies `mate-sandbox-admin` any `pods/exec`, `pods/attach` or `pods/portforward` into `mate`, which holds mate's credentials and every thread's sandbox. The sandbox's network policy also excludes `mate` from its in-cluster egress. Both guard against accidents, not intent: an operator sandbox is `cluster-admin`, so it can read mate's Secrets or delete the policy. `mate-sandbox-reader` holds no `pods/exec`, `pods/attach` or `pods/portforward` anywhere.

## Rules

- Keep one replica with `strategy: Recreate`. Two pods on Discord both reply, two on Slack each get half the events, and both write each thread's session.
- Run no second mate against `mate-db`, such as a local run with its `DATABASE_URL`. Both would refresh the one ChatGPT token, and OpenAI refuses a refresh token spent twice. `bun run smoke` in `apps/mate` is the exception: it answers on the fallback model, and opens no thread but its own.
- Keep the probe readiness-only. `/healthz` returns 503 while mate waits for Discord's session start limit, so a liveness probe restarts mate and spends more of it.
- Keep `MATE_TURN_MINUTES` under 55, or mate does not start.
- Keep `MATE_MAX_SANDBOXES` plus `MATE_SPARES` sandboxes within oldschool's free CPU. Each sandbox requests 500m, and one that does not fit stays `Pending`.
- Keep `terminationGracePeriodSeconds` at 45 or more. On SIGTERM mate lets running turns finish, then closes the rest, and the next pod resumes each one in a new message. A resumed command returns as interrupted, with its outcome unknown.
- Expect background processes to end with the turn, because mate shuts `mate-hands` down at turn end.
- Bump `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord` together, while no turn runs: `mate-db` holds sessions in pi's format, and the new version resumes any open run. pi marks `pi-durable` experimental, so read its changelog before a bump.

## Where it lives

- `apps/mate/src/mate.ts`: the process, built from its config, its clock, its cluster, its database and its chat surfaces, with its timers and the order it stops in
- `apps/mate/src/brain.ts`: the agent loop, one pi-durable harness per open thread
- `apps/mate/src/sandbox-lease.ts`: a turn's lease on its sandbox, and the sandbox cap
- `apps/mate/src/hands-env.ts`: pi's execution environment over the `mate-hands` stream
- `apps/mate/src/credentials.ts`: the credential files of a turn
- `apps/mate/src/sandboxes.ts`: the Sandbox, its manifest and the spare pool
- `apps/mate/src/store.ts`: the connection to `mate-db` and the `mate_threads` table
- `apps/mate/src/credential-store.ts`: the `mate_credentials` table
- `apps/mate/src/chatgpt.ts`: the ChatGPT sign-in, the `chatgpt` commands and the keeper that refreshes the token
- `apps/mate/src/route.ts`: the router between ChatGPT and the fallback, and its breaker
- `apps/mate/src/profiles.ts`: the profiles, their grants, budgets and overrides
- `apps/mate/src/profile.ts`: the system prompt, its persona and the owner's instructions
- `apps/mate/src/mcp.ts`: the kthx MCP bridge
- `apps/mate/src/kthx-sites.ts`: the ledger of kthx site bearers
- `packages/pi-store-postgres/`: pi's session storage on Postgres
- `packages/mate-hands/`: the `mate-hands` daemon, and the protocol that `apps/mate/src/hands.ts` speaks to it
- `images/mate-sandbox/Dockerfile`: the sandbox image
- `clusters/offsite/apps/mate/database.yaml`: the session store
- `clusters/offsite/monitoring/mate-rules.yaml`: alerts, tested by `mise run k8s:check-rules`
- `.github/containers.json`: the CD entries for both images
