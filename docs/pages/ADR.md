icon:: 📜

- **Architecture Decision Records** capture decisions with lasting consequences: the context that forced a choice, the choice made, and what it costs. They are the "why" behind [[Architecture]].
- ## Process
	- Copy [[ADR/Template]] to a new page `ADR/NNNN <short title>` (next free number), set `status:: proposed`, and open a PR.
	- Discussion happens on the PR; merging with `status:: accepted` makes it canon.
	- ADRs are immutable once accepted — a change of course gets a **new** ADR that lists the old one in `supersedes::`, and the old one flips to `status:: superseded`.
	- ADRs 0001–0008 were backfilled on [[Jul 8th, 2026]] to document decisions already in effect; their dates approximate when the decision actually landed.
- ## The records
	- [[ADR/0001 GitOps apply model]] — operators apply desired state; humans only merge
	- [[ADR/0002 Monorepo layout]] — one repo: apps/, packages/, images/, terraform/, clusters/, nix/
	- [[ADR/0003 Cluster topology single source of truth]] — network facts live in per-cluster JSON ConfigMaps
	- [[ADR/0004 Disko with GPT partlabels]] — declarative partitioning keyed on `disk-main-*` labels
	- [[ADR/0005 Cilium BGP load balancing]] — Cilium advertises VIPs; the gateway firewall gates cross-site
	- [[ADR/0006 Dotfiles vendored in-repo with chezmoi]] — no home-manager, no separate repo
	- [[ADR/0007 Offline root CA with YubiKey and SLIP-0039]] — root stays offline; Vault runs the intermediate
	- [[ADR/0008 Diskless netboot for rackpi5]] — stateless RAM image served from spore
	- [[ADR/0009 Logseq wiki on Cloudflare Pages]] — this wiki
	- [[ADR/0010 First-party Bun SSG for the wiki]] — the renderer that actually builds it
