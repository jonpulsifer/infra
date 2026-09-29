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

To stop a turn, use Discord's Stop button or Slack's stop control.

`chatgpt login`, `chatgpt status`, `chatgpt logout`, `chatgpt pause [minutes]` and `chatgpt resume` manage Rowbutt's ChatGPT sign-in and whether ChatGPT answers, and never reach the agent. [Sign Rowbutt in to ChatGPT](../runbooks/sign-rowbutt-in-to-chatgpt.md) and [Operate the Rowbutt model fallback](../runbooks/operate-the-rowbutt-model-fallback.md) have the steps.

## What the agent can do

The agent runs every command without approval. The allowlist in [Use it](#use-it) is the only gate on what it can do.

| Access | Scope |
| --- | --- |
| Repository | `main`, with `AGENTS.md` and the repository skills |
| GitHub | Pushes branches, opens pull requests and merges any pull request whose required checks pass, as `clanky-bot[bot]`. Its comments can plan and apply OpenTofu changes through Atlantis. |
| offsite and folly clusters | `cluster-admin` on both, through the contexts `offsite` and `folly` |
| Hosts | SSH as `rowbutt`, the host user for Rowbutt, which has passwordless sudo on every NixOS host. It reaches both sites' nodes, and folly's Lab Net hosts through riptide. weatherpi4 and oldboy have no route from the sandbox. |
| Internet | Every host on ports 80 and 443 |
| [kthx](kthx.md) | Quick sites, through the `kthx` CLI on `kthx.lolwtf.ca`; mate keeps the site bearers in Secret `mate-kthx-sites`. Built apps, through the `kthx_*` tools that mate bridges from the kthx MCP server, when Secret `mate-kthx-agent` holds an agent token. |
| Phone | Rings the owner's cell through [Switchboard](switchboard.md) with a one-line reason; Switchboard fixes the number and caps the calls. Parked today, so a ring gets no answer; its page has the state. |

[The fence](mate/how-it-works.md#fence) keeps `pods/exec` out of `mate`, which holds mate's own credentials and every sandbox. It guards against accidents only: as `cluster-admin` and root on the hosts, the agent can read mate's Secrets or remove the fence.

## Limits

- A turn runs at most 45 minutes. A thread has 30 turns, and all threads share 120 in a rolling day.
- At most two turns run at once, and other threads wait in a queue.
- At most two threads hold a sandbox at once. A turn that needs one takes the sandbox of a thread idle for 5 minutes, which deletes that thread's uncommitted work, or waits.
- Credentials and background processes last only for the turn.
- After 30 quiet minutes, mate deletes the sandbox with any uncommitted work and archives the Discord thread. mate keeps the conversation, so a reply continues it in a new sandbox.

## How it works

mate is one Bun process, and its ingress admits only the node it runs on. It runs the agent loop on pi, a TypeScript agent library, against the model in `MATE_MODEL` on the owner's ChatGPT subscription. When ChatGPT cannot answer, the OpenCode Go model in `MATE_FALLBACK_MODEL` answers, and mate holds its key. It keeps each thread's session in the Postgres database `mate-db`, the [session store](mate/how-it-works.md#session-store), with a nightly dump. The first tool call of a turn leases the thread's `Sandbox`, which the agent-sandbox controller runs on [oldschool](../hosts/oldschool.md), and writes short-lived GitHub and cluster tokens and the `rowbutt` SSH key into it. A turn that only talks creates no sandbox. If mate restarts mid-turn, it resumes the turn in a new message. [How Rowbutt works](mate/how-it-works.md) has the details.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `MateGitHubCredentialBroken`, `MateGitHubTokenMintFailing` | mate cannot mint GitHub tokens, so sandboxes cannot push | [Repair the Rowbutt GitHub credential](../runbooks/repair-the-rowbutt-github-credential.md) |
| `MateKthxSitesSyncFailing` | mate could not read back or save a sandbox's kthx site tokens. A site claimed in that turn may be orphaned. Read the mate log. | |
| `MateChatGPTSignedOut`, `MateChatGPTTokenNotRefreshing` | mate holds no working ChatGPT sign-in, or a day of token refreshes failed | [Sign Rowbutt in to ChatGPT](../runbooks/sign-rowbutt-in-to-chatgpt.md) |
| `MateModelPrimaryFailing` | ChatGPT fails mate's requests for a reason other than its usage limit or the sign-in, so the fallback model answers | [Operate the Rowbutt model fallback](../runbooks/operate-the-rowbutt-model-fallback.md) |
| `MateStoreFailing`, `MateDatabaseDown`, `MateDatabaseVolumeFilling`, `MateDatabaseBackupFailing` | mate cannot reach the session store, or the store is down, past 80% of its volume, or has no dump from the last 36 hours | [Operate Postgres](../runbooks/operate-postgres.md) |

The other alerts are in `clusters/offsite/monitoring/mate-rules.yaml`, and each `description` names its fix.

To disable the agent, set `MATE_SANDBOXES` to `stub` in `clusters/offsite/apps/mate/deployment.yaml`. To take turns off ChatGPT until mate restarts, say `chatgpt pause <minutes>`. CD restarts mate at each new image, so for longer, set `MATE_MODEL` to the fallback's model and `MATE_FALLBACK_MODEL` to `none`, as [Operate the Rowbutt model fallback](../runbooks/operate-the-rowbutt-model-fallback.md) says. To disable GitHub, cluster, host or phone access, unset `MATE_GITHUB_APP_ID`, `MATE_SANDBOX_KUBE_SA`, `MATE_SSH_KEY_FILE` or `MATE_SWITCHBOARD_URL`. To keep the agent off folly, unset `MATE_SANDBOX_KUBE_PEERS`. To disable kthx quick sites or built apps, unset `MATE_KTHX_ORIGIN` or `MATE_KTHX_MCP_URL`. [Connect an agent to kthx](../runbooks/connect-an-agent-to-kthx.md#give-rowbutt-a-token) gives Rowbutt its built-apps token.

## Reference

- Source: `apps/mate/`, `images/mate-sandbox/`, `packages/mate-hands/` and `packages/pi-store-postgres/`
- Manifests: `clusters/offsite/apps/mate/`
- Images: `ghcr.io/jonpulsifer/mate`, `ghcr.io/jonpulsifer/mate-sandbox`
