icon:: 🚒

- Operational procedures for when things misbehave. Runbooks live here — on Cloudflare, off the infrastructure they describe — precisely so they stay readable during an outage ([[ADR/0009 Logseq wiki on Cloudflare Pages]]).
- ## The runbooks
	- [[Runbooks/Deploy a NixOS Host]] — build, deploy, verify, and roll back NixOS hosts
	- [[Runbooks/Terraform Change]] — Atlantis-first Terraform workflow and local validation
	- [[Runbooks/Kubernetes GitOps Change]] — inspect Flux, reconcile resources, and handle SOPS safely
	- [[Runbooks/Add Shared Kubernetes Resource]] — use the `clusters/base/` pattern for both clusters
	- [[Runbooks/Validate Infra Changes]] — validation commands by change area
	- [[Runbooks/Inspect UniFi Network]] — read-only UniFi discovery before Terraform changes
	- [[Runbooks/Kiosk]] — the Raspberry Pi kiosk hosts (`homepi4`, `weatherpi4`): Cage/Wayland, Firefox, container-backed apps
	- [[Runbooks/TPM Audit]] — TPM inventory of the k8s fleet and how it was gathered
- ## Conventions
	- Tag runbook pages `#runbook`, lead with quick checks, then symptom-shaped sections ("If X…"), each with copy-pasteable commands and expected output.
	- Commands should assume the reader is on the tailnet or LAN; note when a host needs a special path (e.g. `weatherpi4` over Tailscale).
	- When a runbook procedure changes the fleet's desired state, the change still ships via git — see [[Architecture/GitOps]].
	- If an Agent Skill covers the same workflow, the public runbook is the durable human source. The skill should backlink to the runbook with Agent Skills `metadata` and, when useful, a one-level `references/runbook.md` bridge.
	- Do not symlink raw `SKILL.md` files into `docs/pages`: skills are agent instructions, not Logseq outline pages, and may include private mechanics that should not be published.
