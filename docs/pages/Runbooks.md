icon:: 🚒

- Operational procedures for when things misbehave. These pages are served from Cloudflare, off the infrastructure they describe, so they stay readable during an outage.
- ## The runbooks
	- [[Runbooks/Deploy a NixOS Host]] — build, deploy, verify, and roll back NixOS hosts
	- [[Runbooks/Terraform Change]] — Atlantis-first OpenTofu workflow and local validation
	- [[Runbooks/Kubernetes GitOps Change]] — inspect Flux, reconcile resources, and handle SOPS safely
	- [[Runbooks/OpenBao Bootstrap]] — initialize and verify the folly OpenBao instance
	- [[Runbooks/Add Shared Kubernetes Resource]] — use the `clusters/base/` pattern for both clusters
	- [[Runbooks/Validate Infra Changes]] — validation commands by change area
	- [[Runbooks/Inspect UniFi Network]] — read-only UniFi discovery before making changes
	- [[Runbooks/Kiosk]] — the Raspberry Pi kiosk hosts: Cage/Wayland, Firefox, container-backed apps
	- [[Runbooks/TPM Audit]] — TPM inventory of the Kubernetes fleet
- ## Conventions
	- Tag runbook pages `#runbook`, lead with quick checks, then symptom-shaped sections ("If X…"), each with copy-pasteable commands and expected output.
	- Prefer `mise run <task>` where a task exists; it encodes the correct binary and flags. Give a raw invocation only where mise has no task — deploying to a live host, `sops`, `flux reconcile`.
	- Commands assume the reader is on the LAN or the tailnet. Note when a host needs a special path.
	- A runbook that changes desired state still ships through git — see [[Architecture/GitOps]].
	- Where an agent skill covers the same workflow, this page is the durable source. The skill carries a `runbook:` pointer in its frontmatter and holds only agent-specific guidance; it does not restate the procedure.
	- Do not symlink `SKILL.md` files into `docs/pages`. Skills are agent instructions, not Logseq outline pages, and this site is public.
