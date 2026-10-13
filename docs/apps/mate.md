---
title: Rowbutt
description: A chat bot, code name mate, that answers the owner in Discord and Slack threads with a coding agent whose tools run in a sandbox on the offsite cluster.
status: live
---

Rowbutt is a chat bot, code name mate, that gives the owner a coding and operations agent in Discord and Slack. mate runs the agent and keeps each thread's conversation in a database. The agent's commands and file edits run in the thread's sandbox, a pod in a Kata microVM on the offsite [Kubernetes](../platform/kubernetes.md) cluster with a clone of this repository. A turn is one prompt and the agent's answer.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Discord | `#general` in the `homelab` server | The user in `MATE_ALLOWED_USER_IDS` |
| Slack | `#general` and `#chatops` in the Folly Mountain Laboratories workspace | The user in `MATE_SLACK_ALLOWED_USER_IDS` |

Mention Rowbutt in one of these channels to open a thread, and reply in it with no mention. Rowbutt ignores messages from every other user.

Rowbutt reacts 👀 on a message it has taken, and swaps the reaction for ✅, ⚠️ or ⏹️ when the turn ends, on both surfaces. On Slack the reaction needs the app's `reactions:write` scope.

Start the opening message with `+investigator` after the mention to open a read-only thread. A thread keeps the profile it opened with, and mate refuses a `+name` that is unknown, cannot open from chat, disagrees with the thread's, or is not the first word.

To stop a turn, use Discord's Stop button or Slack's stop control, or reply `stop`. Each also cancels the thread's pending [wake](#wakes).

`chatgpt login`, `chatgpt status`, `chatgpt logout`, `chatgpt pause [minutes]` and `chatgpt resume` manage Rowbutt's ChatGPT sign-in and whether ChatGPT answers. While `MATE_MODEL` is a ChatGPT model, they never reach the agent; otherwise the model answers them as prompts. [Sign Rowbutt in to ChatGPT](../runbooks/sign-rowbutt-in-to-chatgpt.md) and [Operate the Rowbutt model fallback](../runbooks/operate-the-rowbutt-model-fallback.md) have the steps.

## Profiles

A profile sets what a thread may do. `apps/mate/src/profiles.ts` declares them, and mate refuses to start with a bad one.

| Profile | Mode | Started by | Cluster identity | Other access | Budget |
| --- | --- | --- | --- | --- | --- |
| `operator` | interactive | The owner's mention | `mate-sandbox-admin` | Everything in [What the agent can do](#what-the-agent-can-do) | The process limits, and the shared interactive day |
| `custodian` | job | The daily check | `mate-sandbox-admin` | As `operator` | 10 turns a UTC day of its own |
| `investigator` | interactive | A mention starting `+investigator` | `mate-sandbox-reader`, read-only on both clusters | GET on Prometheus and Alertmanager, and the `weather_*` tools | 20-minute turns, 10 a thread, and the shared interactive day |
| `responder` | job | An Alertmanager notification | As `investigator` | As `investigator` | 20-minute turns, 10 a thread, 30 a UTC day of its own |
| `dreamer` | job | The nightly dream | None | GitHub, to open one pull request, and the `recall_*` tools | 30-minute turns, 5 a thread, 5 a UTC day of its own |

- Interactive: the owner's threads, which share the turn slots and the daily count.
- Automation: a trusted trigger's thread, which runs one turn at a time and closes after 30 quiet minutes.
- Job: an automation thread that releases its sandbox and closes when its turn ends.

## Daily custodian

mate starts a daily homelab check at 18:00 `America/Halifax` in Slack `#chatops`, configured by `MATE_CUSTODIAN_CHANNEL` in `clusters/offsite/apps/mate/deployment.yaml`. It checks the clusters, Flux, alerts, backups, hosts and PR status. The report opens with a numbered list of what needs the owner, each with the reason, its evidence and a proposed action. It then lists what Rowbutt fixed, with PR links, and any check it could not run. A day with nothing for the owner and nothing fixed is one line. The assignment can fix clear problems through branches and PRs and merge understood PRs once required checks pass and reviews do not block. It does not bypass protections, make live infrastructure changes by hand or apply Atlantis plans without the owner's approval. It runs under the `custodian` profile in job mode, with operator's access and 10 turns a UTC day of its own.

mate records the day and Slack root in `mate-db` and posts the assignment into the thread. The thread's row is the attempt, so a refused or failed check is said once in its thread, and a reply runs it again. A reply to the report, such as `fix 2`, runs a `custodian` turn with the report in its session. Each reply is its own job turn: it counts toward the 10 a day and runs in a new sandbox that mate releases when it ends, so work left uncommitted does not reach the next reply. mate releases the sandbox when the report is done. A restart resumes an interrupted turn. If mate stops after Slack accepts the root but before its timestamp reaches the database, a retry can post a second root. `apps/mate/src/custodian.ts` owns this schedule; unset `MATE_CUSTODIAN_CHANNEL` to stop new reports.

## Alert responder

offsite's Alertmanager posts each firing `warning` or `critical` alert group to mate, and mate opens a thread for it in Slack `#chatops`, configured by `MATE_RESPONDER_CHANNEL` in `clusters/offsite/apps/mate/deployment.yaml`. The root names the alert, the cluster, the count and the severity, with the first alert's message under it. The thread's assignment lists every firing alert with its labels and annotations, and asks for a read-only investigation: whether each alert still fires, what changed and why, the evidence, and the change the agent would make, naming the runbook or the file that owns the fix. It runs under the `responder` profile in job mode, with `investigator`'s access and 30 turns a UTC day of its own. The groups are Discord's, so an incident with several alert names opens a thread for each, one turn at a time in the automation lane, and the daily cap bounds what an incident spends; a group past the cap gets a line saying so, and Discord has the alert.

A group is one thread while it fires. An alert that joins the group wakes the thread with its details, a repeat notification opens nothing, an alert that leaves and rejoins an open group wakes nothing, and the resolution is one `✅ resolved` line. A group that fires again after it resolved gets a new thread. A reply in the thread runs a `responder` turn in a new sandbox, read-only like the first; the owner makes changes in a thread of their own. `apps/mate/src/responder.ts` owns this, with the rows in `mate_alert_groups`. [Alerting](../platform/observability/alerting.md) has the route, which `clusters/offsite/monitoring/alertmanager-mate.yaml` declares and the selector in `kube-prometheus.yaml` turns on.

## Memory and dreams

Rowbutt remembers in `dotfiles/pi/mate/memory.md`: one fact a line about the lab and how the owner works, dated, under the headings the file sets. Every profile reads it into its system prompt after the repository's `AGENTS.md`, and the owner's local pi reads it through the `mate` pi package, so it holds facts and never a capability, a credential or a private detail. The file is kept under 120 lines.

Each night at 03:00 `America/Halifax` mate opens a dream thread in Slack `#chatops`, configured by `MATE_DREAMS_CHANNEL` in `clusters/offsite/apps/mate/deployment.yaml`, under the `dreamer` profile in job mode. The assignment reads the threads active since the previous dream, or the last 24 hours the first time and at most 7 days after a gap, with the `recall_threads` and `recall_thread` tools, and distils three kinds of lesson: a fact for the memory, a skill in `.agents/skills/` or `dotfiles/skills/` that misled a turn, and a page in `docs/` that disagrees with what a thread saw. It opens one pull request from branch `dreams/<day>` with every edit and never merges it. The owner's review is the control: the memory reaches the system prompt of every profile, the cluster-admin ones included, and a transcript the dreamer reads is untrusted text with a push token in reach, so read a dream's diff before merging it. The repository is public, so the assignment keeps out anything that names a person other than the owner, a credential or the content of a private conversation, and reports what it kept private in the thread instead. A night with nothing worth keeping opens no pull request and reports one line. The dreamer's sandbox has a GitHub token and no cluster, host, 1Password or phone access. A reply in the thread runs another `dreamer` turn, so the owner can ask it to look again or at something else, and a dream whose turn failed runs again over the same window from a reply; the next night starts where this one's window ended. `apps/mate/src/dreams.ts` owns the schedule, with the rows in `mate_dreams`; unset `MATE_DREAMS_CHANNEL` to stop dreaming.

Under `operator` and `dreamer`, the `recall_threads` tool lists mate's threads whose last message falls in a window of at most 30 days, newest first, with each thread's key, profile, turns and opening ask, and `recall_thread` reads one as a transcript: the owner's messages, Rowbutt's replies, its tool calls and their results, each with anything shaped like a secret redacted and then clipped, in pages of 24,000 characters. The tools read `mate-db` from mate itself; no sandbox reaches the database. A dream thread never appears in a listing. `apps/mate/src/recall.ts` owns them.

## Wakes

Under `operator` and `custodian`, the agent's `wake` tool continues the thread later in a new turn. A wake fires after 5 to 1,440 minutes. A wake for a pull request fires once the PR is merged or closed, or every GitHub Actions run on its head has finished, or at the deadline. mate polls GitHub each minute with the App's token and spends no model turn while it waits. It reads Actions runs only, not Atlantis's status, and a head with no run 15 minutes after the wake was set counts as finished. A thread holds one wake, and a new one replaces it. mate posts `⏰` lines when a wake is set, when it fires and when it is cancelled. The woken turn runs as a reply from whoever set the wake, so it counts toward the same limits. Replies leave the wake pending. `apps/mate/src/wakes.ts` owns this, with the rows in `mate_wakes`.

## What the agent can do

The agent runs every command without approval. The allowlist in [Use it](#use-it) is the only gate on what it can do. Under `operator` and `custodian` it has this access. The read-only cluster token row in [How Rowbutt works](mate/how-it-works.md#credentials) gives `investigator`'s.

| Access | Scope |
| --- | --- |
| Repository | `main`, with `AGENTS.md` and the repository skills |
| GitHub | Pushes branches, opens pull requests and merges the pull requests it opened once their required checks pass, as `clanky-bot[bot]`. The [daily custodian](#daily-custodian) assignment's own merge rule replaces that limit with pull requests it understands. The system prompt sets these limits; the token can merge any pull request. Its comments can plan and apply OpenTofu changes through Atlantis. |
| offsite and folly clusters | `cluster-admin` on both, through the contexts `offsite` and `folly` |
| Hosts | SSH as `rowbutt`, the host user for Rowbutt, which has passwordless sudo on every NixOS host. It reaches both sites' nodes, and folly's Lab Net hosts through capsule. weatherpi4 and oldboy have no route from the sandbox. |
| Internet | Every host on ports 80 and 443 |
| [kthx](kthx.md) | Quick sites, through the `kthx` CLI on `kthx.lolwtf.ca`; mate keeps the site bearers in Secret `mate-kthx-sites`. Built apps, through the `kthx_*` tools that mate bridges from the kthx MCP server, when Secret `mate-kthx-agent` holds an agent token. |
| Weather | Canadian weather and the family Tempest stations, through the `weather_*` tools that mate bridges from the [Weather API](weather.md) at `MATE_WEATHER_MCP_URL`. The server takes no token. |
| Phone | Rings the owner's cell through [Switchboard](switchboard.md) with a one-line reason, and sends the mission caller, in the owner's voice, after an allow-listed family member with a word to get out of them; Switchboard fixes the numbers and caps the calls. |
| Memory | `dotfiles/pi/mate/memory.md` in the system prompt, and the `recall_threads` and `recall_thread` tools over mate's own threads in `mate-db` ([Memory and dreams](#memory-and-dreams)) |

[The fence](mate/how-it-works.md#fence) keeps `pods/exec` out of `mate`, which holds mate's own credentials and every sandbox. It guards against accidents only: as `cluster-admin` and root on the hosts, the agent can read mate's Secrets or remove the fence.

## Limits

- A turn runs at most 45 minutes. A thread has 30 turns, and all interactive threads share 120 in a rolling day. An investigator turn runs at most 20 minutes, with 10 per thread.
- At most two interactive turns run at once, and other threads wait in a queue. Automation and job profiles run one turn at a time and have their own daily caps in `mate-db`.
- At most two threads hold a sandbox at once. A turn that needs one takes the sandbox of a thread idle for 5 minutes, which deletes that thread's uncommitted work, or waits. An automation turn never takes an interactive thread's sandbox, but it can take a free one, so while the custodian runs the owner's threads share one fewer.
- An investigator reads logs with `kubectl logs`; VictoriaLogs is not reachable from a read-only sandbox.
- Credentials and background processes last only for the turn. A [wake](#wakes) is the way back to a thread later.
- After 30 quiet minutes, mate deletes the sandbox with any uncommitted work and archives the Discord thread. mate keeps the conversation, so a reply continues it in a new sandbox, across restarts too.
- Slack retries a message for about six minutes, so one sent while mate is down for longer gets no answer.
- Discord does not replay a message sent while mate is disconnected, so it gets no answer and nothing counts it.
- The agent sees a file on a message only as its name, type and size.

## How it works

mate is one Bun process, and its ingress admits only the node it runs on and Alertmanager. It runs the agent loop on pi, a TypeScript agent library, against the model in `MATE_MODEL` on the owner's ChatGPT subscription. When ChatGPT cannot answer, the OpenCode Go model in `MATE_FALLBACK_MODEL` answers, and mate holds its key. It keeps each thread's session in the Postgres database `mate-db`, the [session store](mate/how-it-works.md#session-store), with a nightly dump. The first tool call of a turn leases the thread's `Sandbox`, which the agent-sandbox controller runs on [hotrod](../hosts/hotrod.md), the sandbox node, and writes the short-lived GitHub and cluster tokens and the `rowbutt` SSH key that its profile grants into it. A turn that only talks creates no sandbox. If mate restarts mid-turn, it resumes the turn in a new message. [How Rowbutt works](mate/how-it-works.md) has the details.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `MateGitHubCredentialBroken`, `MateGitHubTokenMintFailing` | mate cannot mint GitHub tokens, so sandboxes cannot push | [Repair the Rowbutt GitHub credential](../runbooks/repair-the-rowbutt-github-credential.md) |
| `MateKthxSitesSyncFailing` | mate could not read back or save a sandbox's kthx site tokens. A site claimed in that turn may be orphaned. Read the mate log. | |
| `MateChatGPTSignedOut`, `MateChatGPTTokenNotRefreshing` | mate holds no working ChatGPT sign-in, or its token refreshes keep failing | [Sign Rowbutt in to ChatGPT](../runbooks/sign-rowbutt-in-to-chatgpt.md) |
| `MateModelPrimaryFailing` | ChatGPT fails mate's requests for a reason other than its usage limit or the sign-in, so the fallback model answers | [Operate the Rowbutt model fallback](../runbooks/operate-the-rowbutt-model-fallback.md) |
| `MateStoreFailing`, `MateDatabaseDown`, `MateDatabaseVolumeFilling`, `MateDatabaseBackupFailing` | mate cannot reach the session store, or the store is down, past 80% of its volume, or has no dump from the last 36 hours | [Operate Postgres](../runbooks/operate-postgres.md) |

The other alerts are in `clusters/offsite/monitoring/mate-rules.yaml`, and each `description` names its fix.

To take mate off Discord and Slack, set `replicas` to `0` in `clusters/offsite/apps/mate/deployment.yaml`. To take turns off ChatGPT until mate restarts, say `chatgpt pause <minutes>`. CD restarts mate at each new image, so for longer, set `MATE_MODEL` to the fallback's model and `MATE_FALLBACK_MODEL` to `none`, as [Operate the Rowbutt model fallback](../runbooks/operate-the-rowbutt-model-fallback.md) says. To disable GitHub, cluster, host, Talos API or phone access, unset `MATE_GITHUB_APP_ID`, `MATE_SANDBOX_KUBE_SA`, `MATE_SSH_KEY_FILE`, `MATE_TALOSCONFIG_FILE` or `MATE_SWITCHBOARD_URL`. To disable read-only cluster access, unset `MATE_SANDBOX_KUBE_READER_SA`. To keep the agent off folly, unset `MATE_SANDBOX_KUBE_PEERS`. To stop opening alert threads, drop `mate` from the selector in `kube-prometheus.yaml`, then unset `MATE_RESPONDER_CHANNEL`; in the other order Alertmanager counts each refused post as a failed notification. To rotate the bearer, edit the item `mate alertmanager token`, then force-sync the ExternalSecrets `mate-alertmanager` in `mate` and `alertmanager-mate` in `monitoring` together; until both hold the new value mate answers 401, which counts as failed too. To disable kthx quick sites or built apps, unset `MATE_KTHX_ORIGIN` or `MATE_KTHX_MCP_URL`. To disable the weather tools, unset `MATE_WEATHER_MCP_URL`. [Connect an agent to kthx](../runbooks/connect-an-agent-to-kthx.md#give-rowbutt-a-token) gives Rowbutt its built-apps token. [Rotate the Rowbutt Slack token](../runbooks/rotate-the-rowbutt-slack-token.md) replaces the Slack App-Level Token when mate warns that Slack splits its events.

> [!WARNING]
> An image from before profiles runs every thread as operator. It never sees a read-only sandbox (`lolwtf.ca/minted-by=mate-reader`, its own name), but a reply in an investigator thread runs as operator in a fresh operator sandbox. Before rolling back, delete the read-only sandboxes with `kubectl --context offsite -n mate delete sandboxes -l lolwtf.ca/minted-by=mate-reader` and leave investigator threads closed.

## Reference

- Source: `apps/mate/`, `images/mate-sandbox/`, `packages/mate-hands/` and `packages/pi-store-postgres/`
- Memory: `dotfiles/pi/mate/memory.md`, beside the persona
- Manifests: `clusters/offsite/apps/mate/`, and the alert route in `clusters/offsite/monitoring/alertmanager-mate.yaml`
- Items in the `homelab` vault: `mate alertmanager token`, the bearer Alertmanager's posts carry
- Images: `ghcr.io/jonpulsifer/mate`, `ghcr.io/jonpulsifer/mate-sandbox`
