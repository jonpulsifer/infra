icon:: 🤝
tags:: architecture

- mate is the Discord bot Rowbutt connects through: a human mentions Rowbutt in an allowed channel of the homelab guild, a public thread opens from that message, and the reply streams back into it, edited in place. Discord's thread is the session; one thread owns at most one sandbox. mate never runs a model itself — it is a gateway client plus an Agent Client Protocol client, and the coding agent it will talk to runs inside a per-thread sandbox on [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox).
- ## Where it lives
	- `apps/mate/src/` is the process: one Bun program with the gateway, the thread contract, the identify-budget guard and `/healthz`. `bun test` there covers the contract logic.
	- `clusters/offsite/apps/mate/` is the workload on the offsite cluster: the `mate` namespace at Pod Security `restricted`, the ExternalSecret that carries Rowbutt's token from 1Password, and one Deployment. It is raw manifests under Flux, not a chart and not a Spindrift App.
	- `.github/containers.json` names the image in `build` and this Deployment in `deploy`, so every build of `apps/mate` that lands on `main` opens a digest-bump PR through the CD App identity.
- ## What is true today
	- Replies come from an in-process stub. No Sandbox is minted: the Deployment carries no ServiceAccount, no RBAC for `agents.x-k8s.io`, no sandbox template and no NetworkPolicy. Those land beside it as the sandbox side takes shape.
	- One replica with `strategy: Recreate`. Discord delivers every event to every gateway session on a token, so two mate pods overlapping on a roll would both reply.
	- The probe is readiness only. `/healthz` answers 503 whenever the gateway is disconnected, including during the budget guard's deliberate sleeps, and a liveness probe on it would kill the process for protecting the identify budget.
	- Gateway session info sits on an emptyDir so a container restart in the same pod resumes rather than identifying again.
	- A rotated token reaches the pod without waiting for Discord to close the stale session: the ExternalSecret refreshes hourly and reloader rolls the Deployment when the Secret changes.
	- No HTTP surface: no Gateway, HTTPRoute, certificate or DNS name. The Discord gateway is an outbound WebSocket.
