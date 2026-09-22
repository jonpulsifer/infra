tags:: runbook, mate, github

- Use this when a sandbox cannot push, when `MateGitHubCredentialBroken` or `MateGitHubTokenMintFailing` fires, or when the `clanky-bot[bot]` App's private key is rotated or its installation changed. mate holds the App's private key and mints installation access tokens from it; a sandbox holds a token and never the key. The design is on [[Architecture/Mate]], the workload is `clusters/offsite/apps/mate/`, the minting is `apps/mate/src/github-app.ts`, and the alerts are `clusters/offsite/monitoring/mate-rules.yaml`.
- # Quick checks
	- What mate said about the credential on the way up. Three lines matter and one grep catches all of them:
	- ```bash
	  kubectl --context offsite logs -n mate deploy/mate | grep -i github
	  ```
	- `github installation found` names the installation id and the repository it was found on. `github app ready` names that installation, the login — `clanky-bot[bot]` — and when the token mate is holding expires. `github app private key does not parse` is the key itself: mate refuses it as it starts rather than meeting it as an OpenSSL sentence at the first push of the day.
	- Whether the credential works right now. `mate_github_app_ready` is 1 when a real mint last succeeded and 0 when it did not, and mate re-proves it on a timer rather than inferring it from how the last turn went — so the reading is current whether or not anyone has asked mate for anything:
	- ```bash
	  kubectl --context offsite -n monitoring port-forward svc/prometheus-operated 9090:9090 &
	  curl -s 'localhost:9090/api/v1/query?query=mate_github_app_ready' | jq -r '.data.result[].value[1]'
	  ```
	- Whether the Secret behind it exists and is filled. `SecretSynced` on the ExternalSecret is the whole answer to "did 1Password give us anything":
	- ```bash
	  kubectl --context offsite -n mate get externalsecret mate-github-app
	  kubectl --context offsite -n mate get secret mate-github-app \
	    -o jsonpath='{.data.private-key}' | base64 -d | head -1
	  ```
	- That last line prints the PEM header and nothing else. It reads `-----BEGIN RSA PRIVATE KEY-----`: GitHub hands out PKCS#1 and mate signs with it as it arrives, so a key that has been converted or re-wrapped on the way into 1Password is a key mate will refuse.
- # What the alerts mean
	- `MateGitHubCredentialBroken` (critical, ten minutes) — the credential mate holds cannot become a token. It is guarded on the Deployment, so a mate that is simply down pages as `MateDown` alone; this one fires at a mate that is up, ready and answering Discord while every sandbox it stamps gets a token that cannot push.
	- `MateGitHubTokenMintFailing` (warning) — more than one mint failed in half an hour against a credential that otherwise reads healthy. This is the intermittent shape the gauge cannot hold still long enough to show: GitHub answering 5xx, a clock far enough out that the signed assertion is refused, an App being reinstalled underneath a running mate.
	- Neither can stand in for the other. A credential that is broken continuously never produces a burst to count, and a burst that ends leaves the gauge back at 1.
	- `mate_github_token_stamps_total` is the step after the mint — a token written into the sandbox pod. A mint that works and a stamp that does not leaves a thread just as unable to push, so compare the two before blaming the credential.
- # If the ExternalSecret is stale
	- The ExternalSecret refreshes hourly, and reloader rolls the Deployment when the Secret it writes changes. To take the hour out of it, annotate the ExternalSecret with a value it has not seen:
	- ```bash
	  kubectl --context offsite -n mate annotate externalsecret mate-github-app \
	    force-sync="$(date +%s)" --overwrite
	  kubectl --context offsite -n mate get externalsecret mate-github-app -w
	  ```
	- `SecretSyncErr` naming the field rather than the item is the shape to know: 1Password Connect serves a Password item's canonical `password` field with no value at all, however full the item looks in the apps, so a reference to it reads as a field that does not exist. The key belongs in a **custom concealed field** with its own label, which is what the ExternalSecret names.
	- Nothing here edits the live Secret. Flux owns the ExternalSecret and External Secrets owns the Secret; a hand-patched value is replaced without warning — see [[Runbooks/Kubernetes GitOps Change]].
- # Rotating the App private key
	- Generate the new key in GitHub: **Settings → Developer settings → GitHub Apps → mate-sandbox → Private keys → Generate a private key**. The browser downloads a `.pem`. An App can hold two keys at once, which is what makes this a rotation rather than an outage.
	- Put the whole PEM — the `BEGIN` and `END` lines included, no re-wrapping — into the custom concealed field the ExternalSecret names, on the item it names, in the `homelab` vault.
	- Force the resync above, then read the boot line. `github app ready` with an expiry in the future is the new key working end to end.
	- Delete the old key in GitHub only after that line appears. Until it does, the old key is what is keeping pushes working.
	- The key never goes into git, into `docs/`, or into a terminal that logs. 1Password is the only copy; [[Runbooks/SOPS Secrets and Age Keys]] covers the other secret path in this repo and is not this one.
- # Reinstalling the App
	- Install from the App's own page: **Install App → jonpulsifer → Only select repositories → infra**. Repository permissions are **Contents: Read and write** and **Pull requests: Read and write**, and nothing else is needed for the loop a turn ends with.
	- The installation id is not configuration. mate derives it from the owner and repository, so an App uninstalled and installed again needs no manifest change — mate logs `github installation gone, rediscovering` and finds the new one. What does need a change is the App id, `MATE_GITHUB_APP_ID` on the Deployment, and that only changes if the App itself is recreated.
	- Widening the installation to more repositories widens every sandbox's credential with it. The scope is one repository because a turn only ever needs one.
	- Keep the slug out of `clusters/offsite/apps/atlantis/policies/only-me.rego` and out of `policies.owners.users` in `clusters/offsite/apps/atlantis/helm-release.yaml`. Its absence from both is why a comment made with this token cannot start a Terraform apply, which is the point of the App being its own identity.
- # If a sandbox cannot push
	- Read `mate_github_app_ready` first. At 0 the credential is the fault and the sections above are the fix.
	- At 1, the token exists and the question is whether it reached the pod. The sandbox holds it as a file, so the check is the file:
	- ```bash
	  kubectl --context offsite -n mate get pods -l app.kubernetes.io/name=mate-sandbox
	  kubectl --context offsite -n mate exec <pod> -c harness -- \
	    sh -c 'ls -l "$MATE_GITHUB_TOKEN_FILE"'
	  ```
	- An absent file is a stamp that failed; a file older than the turn is a stamp that did not run. Either way mate's log is where the reason is.
	- A present file that GitHub refuses is the installation rather than the plumbing. Ask GitHub what the token can do:
	- ```bash
	  kubectl --context offsite -n mate exec <pod> -c harness -- \
	    gh api repos/jonpulsifer/infra --jq .permissions
	  ```
	- `push: true` and the token still refused means the push is not the problem — check that git is using the credential at all. The helper is handed in through git's command scope, so it shows as command-line configuration rather than as anything in a file:
	- ```bash
	  kubectl --context offsite -n mate exec <pod> -c harness -- \
	    git -C /workspace config --list --show-origin | grep -i credential
	  ```
	- The username in that helper's answer is the literal `x-access-token`. GitHub takes an installation token as the password of a basic-auth pair with exactly that username, so a helper answering anything else fails against a token that is perfectly good.
	- A push that hangs rather than fails is the egress policy, not the credential. A sandbox is allowed `github.com` and `api.github.com` by name and nothing else on 443 — `clusters/offsite/apps/mate/sandbox-network-policy.yaml` is the list.
	- `gh` reads the same file through the wrapper the image puts on PATH ahead of the real binary, `images/mate-sandbox/gh`. A `gh` that asks for a login while git pushes fine is that wrapper, not the token.
- # Before the App exists
	- `MATE_GITHUB_APP_ID` on the Deployment and the item id in the ExternalSecret are both placeholders until the App is created, so the `mate-github-app` Secret is not written and the volume mounts empty. mate has no key to sign with and mints nothing.
	- The bot answers anyway. The volume is `optional: true` precisely so a missing Secret does not hold the pod in `CreateContainerConfigError` — under `strategy: Recreate` the pod that was answering is already gone by the time that would be noticed.
	- `MateGitHubCredentialBroken` fires throughout, and that is the correct reading rather than a false alarm: the credential is declared and unusable, and a sandbox can clone the public repo and cannot push. Creating the App, filling the 1Password item and replacing both placeholders is what clears it.
