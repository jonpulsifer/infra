---
title: Rowbutt
description: A chat bot, code name mate, that answers the owner in Discord and Slack threads with a coding agent in a sandbox on the offsite cluster.
status: live
---

Rowbutt is a chat bot, code name mate, that gives the owner a coding and operations agent in Discord and Slack. Each thread gets a sandbox, a pod in a Kata microVM on the offsite [Kubernetes](../platform/kubernetes.md) cluster. The sandbox has a clone of this repository and OpenCode, an open-source coding agent. A turn is one prompt and the agent's answer.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Discord | `#general` in the `homelab` server | The user in `MATE_ALLOWED_USER_IDS` |
| Slack | `#general` and `#chatops` in the Folly Mountain Laboratories workspace | The user in `MATE_SLACK_ALLOWED_USER_IDS` |

Mention Rowbutt in one of these channels to open a thread, and reply in it with no mention. Rowbutt ignores messages from every other user.

To stop a turn, use Discord's Stop button or Slack's stop control.

## What the agent can do

The agent runs every command without approval.

| Access | Scope |
| --- | --- |
| Repository | `main`, with `AGENTS.md` and the repository skills |
| GitHub | Pushes branches and opens pull requests as `clanky-bot[bot]`. Its comments can plan OpenTofu changes through Atlantis. |
| offsite cluster | Reads every resource except Secrets, and has `pods/exec` in every pod but `mate`'s own namespace and the namespaces [the fence](mate/how-it-works.md#fence) excludes |
| Hosts | None. `rowbutt`, the host user for Rowbutt, is in `wheel` on every host, and the sandbox has no SSH key for it. |
| [kthx](kthx.md) | Quick sites, through the `kthx` CLI on `kthx.lolwtf.ca`; mate keeps the site bearers in Secret `mate-kthx-sites`. Built apps, through the `kthx` MCP tools, when Secret `mate-kthx-agent` holds an agent token. |
| Phone | Rings the owner's cell through [Switchboard](switchboard.md) with a one-line reason. Switchboard fixes the number and caps the calls per day. |

With `pods/exec`, the agent can still read the credentials of any pod in a namespace the fence leaves open. The owner accepts this residual risk. [The fence](mate/how-it-works.md#fence) keeps `pods/exec` out of `mate`, which holds mate's own credentials and every sandbox, and out of each namespace the policy names or that carries the `lolwtf.ca/sandbox-exec: deny` label.

## Limits

- A turn runs at most 45 minutes. A thread has 30 turns, and all threads share 120 in a rolling day.
- At most two threads have a sandbox at once. Other threads wait in a queue.
- After 30 quiet minutes, mate deletes the sandbox with any uncommitted work and archives the Discord thread. A reply starts a new sandbox with the newest 40 messages as context.

## How it works

mate is one Bun process, and its ingress admits only the node it runs on. For each thread, it creates a `Sandbox` object, which the agent-sandbox controller runs on [oldschool](../hosts/oldschool.md). Each turn gets short-lived GitHub and cluster tokens. [How Rowbutt works](mate/how-it-works.md) has the details.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `MateGitHubCredentialBroken`, `MateGitHubTokenMintFailing` | mate cannot mint GitHub tokens, so sandboxes cannot push | [Repair the Rowbutt GitHub credential](../runbooks/repair-the-rowbutt-github-credential.md) |
| `MateKthxSitesSyncFailing` | mate could not read back or save a sandbox's kthx site tokens. A site claimed in that turn may be orphaned. Read the mate log. | |

The other alerts are in `clusters/offsite/monitoring/mate-rules.yaml`, and each `description` names its fix.

To disable the agent, set `MATE_SANDBOXES` to `stub` in `clusters/offsite/apps/mate/deployment.yaml`. To disable GitHub or cluster access, unset `MATE_GITHUB_APP_ID` or `MATE_SANDBOX_KUBE_SA`. To disable kthx quick sites or built apps, unset `MATE_KTHX_ORIGIN` or `MATE_KTHX_MCP_URL`. [Connect an agent to kthx](../runbooks/connect-an-agent-to-kthx.md#give-rowbutt-a-token) gives Rowbutt its built-apps token.

## Reference

- Source: `apps/mate/` and `images/mate-sandbox/`
- Manifests: `clusters/offsite/apps/mate/`
- Images: `ghcr.io/jonpulsifer/mate`, `ghcr.io/jonpulsifer/mate-sandbox`
