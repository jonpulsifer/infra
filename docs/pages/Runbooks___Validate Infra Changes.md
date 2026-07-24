tags:: runbook, validation

- Use this as the pre-PR validation index. Deeper workflows live in the linked runbooks.
- # Docs and wiki
	- Build the wiki:
	- ```bash
	  bun run --cwd apps/wiki build
	  ```
	- Check Logseq page links manually in the generated site when adding or renaming pages.
- # Nix and NixOS
	- Full flake check:
	- ```bash
	  nix flake check
	  ```
	- Host build:
	- ```bash
	  nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel --no-link
	  ```
	- See [[Runbooks/Deploy a NixOS Host]].
- # Kubernetes
	- Build the kustomization root that includes the changed file:
	- ```bash
	  kubectl kustomize clusters/<cluster>/<category>
	  ```
	- For shared base changes, validate every consuming cluster:
	- ```bash
	  kubectl kustomize clusters/folly/<category>
	  kubectl kustomize clusters/offsite/<category>
	  ```
	- See [[Runbooks/Kubernetes GitOps Change]] and [[Runbooks/Add Shared Kubernetes Resource]].
- # Terraform
	- The binary is **OpenTofu** (`tofu`), not `terraform`. Validate every root the same way CI does:
	- ```bash
	  mise run tf:init
	  mise run tf:validate
	  ```
	- Format:
	- ```bash
	  mise run tf:fmt
	  ```
	- See [[Runbooks/Terraform Change]].
- # Secrets safety
	- Do not put decrypted SOPS values, API tokens, passwords, private keys, or one-time tokens in docs, PR comments, logs, or screenshots.
	- A crude docs scan before publishing sensitive-adjacent runbooks:
	- ```bash
	  rg -n "op item|--reveal|password|token|private key|BEGIN .*KEY" docs/pages
	  ```
- # Tooling
	- Prefer `mise` for portable validation tooling:
	- ```bash
	  mise install
	  ```
	- Use the Nix dev shell for NixOS-specific builds and formatters.
