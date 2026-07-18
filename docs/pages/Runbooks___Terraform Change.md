tags:: runbook, terraform

- Use this when changing Terraform under `terraform/` or cluster bootstrap Terraform under `clusters/<site>/bootstrap/`. Background lives in [[Architecture/Terraform]] and the apply model is [[ADR/0001 GitOps apply model]].
- # Rule
	- Terraform applies run through Atlantis on the PR. Do not run `terraform apply` against remote state locally; it can race Atlantis, lock state, and create drift.
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
		- `clusters/folly/bootstrap`
		- `clusters/offsite/bootstrap`
- # Local validation
	- From the changed root:
	- ```bash
	  terraform init -backend=false
	  terraform validate
	  ```
	- Format before review when practical:
	- ```bash
	  terraform fmt -recursive
	  ```
	- Local plans are inspection only:
	- ```bash
	  terraform init
	  terraform plan
	  ```
- # PR flow
	- Open a PR with the `.tf` change.
	- Atlantis autoplans the changed root modules.
	- Review the Atlantis plan comment.
	- Comment `atlantis apply` only after the plan is reviewed and expected.
	- A successful Atlantis apply automerges according to the repo workflow.
- # If validation fails
	- For backend errors during local validation, retry with `-backend=false`.
	- For provider/schema errors, run from the exact root that owns the changed files.
	- For plans that include unexpected replacement or deletion, stop and inspect state/import history before applying.
- # Notes
	- The `terraform/network/` roots keep historical GCS state prefixes that do not always match the current directory name.
	- Network facts should come from the cluster topology single source of truth where a root already has a `topology.tf`; see [[ADR/0003 Cluster topology single source of truth]].
