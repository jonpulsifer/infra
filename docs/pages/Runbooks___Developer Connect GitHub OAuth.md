tags:: runbook, terraform, gcp

- Use this once after the Terraform change creating the `github` Developer Connect connection in `trusted-builds` applies through Atlantis. The connection is created without credentials and waits in `PENDING_USER_OAUTH`; a browser authorization completes it. Config lives in `terraform/gcp/projects/trusted-builds/developer-connect.tf`.
- # Quick check
	- ```bash
	  gcloud developer-connect connections describe github \
	    --project=trusted-builds --location=northamerica-northeast1 \
	    --format='value(installationState.stage)'
	  ```
	- `COMPLETE` means there is nothing to do here.
- # Authorize
	- Get the next-action link:
	- ```bash
	  gcloud developer-connect connections describe github \
	    --project=trusted-builds --location=northamerica-northeast1 \
	    --format='value(installationState.stage, installationState.actionUri)'
	  ```
	- Open the `actionUri` in a browser as the GitHub account that owns `jonpulsifer/infra`, authorize the Developer Connect GitHub App, and when GitHub asks where to install it, scope the installation to the `jonpulsifer/infra` repository only.
	- Re-run the describe until `installationState.stage` reads `COMPLETE`. Developer Connect stores the OAuth token as a Secret Manager secret it creates in `trusted-builds`; the token never touches git or Terraform state.
- # After authorization
	- The connection's `appInstallationId` and `authorizerCredential` are server-populated. The Terraform config leaves both undeclared, so the follow-up plan for the repository link shows the connection unchanged — if the Atlantis plan on that PR shows any change to `google_developer_connect_connection.github`, stop and investigate before applying.
