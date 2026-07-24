tags:: runbook, terraform

- Use this when changing Terraform under `terraform/` or cluster bootstrap Terraform under `clusters/<site>/bootstrap/`. Background lives in [[Architecture/Terraform]]; the apply model (Atlantis autoplan → review → `atlantis apply` → automerge) is on [[Architecture/GitOps]].
- # Rule
	- The binary is **OpenTofu** (`tofu`), not `terraform` — `mise.toml` installs both, but Atlantis applies with `ATLANTIS_DEFAULT_TF_DISTRIBUTION=opentofu` and CI runs `tofu`. Terraform applies run through Atlantis on the PR. Do not run `tofu apply` against remote state locally; it can race Atlantis, lock state, and create drift.
- # Find the root module
	- Each Terraform root has its own state and backend. Common roots:
		- `terraform/network/unifi/folly`
		- `terraform/network/unifi/offsite`
		- `terraform/network/cloudflare`
		- `terraform/network/tailscale`
		- `terraform/gcp/organization`
		- `terraform/gcp/projects/<name>`
		- `terraform/argo`
		- `terraform/google-workspace`
		- `terraform/pki`
		- `clusters/folly/bootstrap`
		- `clusters/offsite/bootstrap`
- # Local validation
	- Preferred — validates every root the same way CI does (`mise tasks ls` lists all `tf:*` tasks):
	- ```bash
	  mise run tf:init
	  mise run tf:validate
	  ```
	- To scope to just the root you changed:
	- ```bash
	  tofu -chdir=<root> init -backend=false
	  tofu -chdir=<root> validate
	  ```
	- Format before review:
	- ```bash
	  mise run tf:fmt
	  ```
	- Local plans are inspection only. Set `TF_DIR` to the root's path from the repo root:
	- ```bash
	  TF_DIR=terraform/network/unifi/folly mise run tf:plan
	  ```
- # PR flow
	- Open a PR with the `.tf` change.
	- Atlantis autoplans the changed root modules.
	- Review the Atlantis plan comment.
	- Comment `atlantis apply` only after the plan is reviewed and expected.
	- A successful Atlantis apply automerges according to the repo workflow.
- # If validation fails
	- For backend errors during local validation, retry with `mise run tf:init` (or `tofu init -backend=false` in the root).
	- For provider/schema errors, run from the exact root that owns the changed files (`tofu -chdir=<root> validate`).
	- For plans that include unexpected replacement or deletion, stop and inspect state/import history before applying.
- # Notes
	- The `terraform/network/` roots keep historical GCS state prefixes that do not always match the current directory name — read the `backend` block rather than inferring the prefix from the path.
	- `terraform/pki` requires OpenTofu specifically: it uses the `opentofu/tls` provider fork for `max_path_length`, unavailable on the Terraform registry.
	- Network facts come from the cluster topology single source of truth (`clusters/<site>/config/cluster-topology.json`) where a root already has a `topology.tf`; see [[Architecture/Terraform]].
