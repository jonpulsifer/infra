---
title: Install kthx
description: Install the kthx engine on the offsite cluster, from the OpenTofu roots to the first passkey.
---

Use this runbook to install the kthx engine on the offsite cluster, or to rebuild it. The engine is the `web` and `reconciler` processes of `apps/spindrift/` and their database. [kthx](../apps/kthx.md#use-it) lists the live addresses.

## Before you start

- Get Atlantis access ([Apply an OpenTofu change](apply-an-opentofu-change.md)), the operator age key ([Manage SOPS secrets](manage-sops-secrets.md)), and offsite access ([Get cluster admin access](get-cluster-admin-access.md)).
- Choose the console hostname, `<hostname>`. The first passkey is registered to it, so browsers must reach it.
- `<public-hostname>` is the `SPINDRIFT_PUBLIC_HOSTNAME` value in `helm-release.yaml`. The Cloudflare tunnel forwards the GitHub webhook and `/mcp` to it.
- For another namespace, change `spindrift` in `namespace.yaml` and on each line that this command prints:

  ```bash
  git grep -n -e 'spindrift:spindrift' -e 'namespace: spindrift$' -e 'spindrift\.spindrift\.svc'
  ```

  Then deploy the Kubernetes control-plane nodes, [optiplex](../hosts/optiplex.md) and [retrofit](../hosts/retrofit.md) ([Deploy a NixOS host](deploy-a-nixos-host.md)).

## Declare the installation

`clusters/offsite/apps/spindrift/` is the installation, and `packages/charts/spindrift/values.yaml` describes its values. A Target is where kthx deploys built apps.

1. Set `hostname` in `helm-release.yaml` to `<hostname>`.
2. Make sure each Kubernetes Target cluster declares an Apps Gateway and binds the Target ClusterRoles.

   offsite declares both in `gateway.yaml` and `target-rbac.yaml`, and folly in `clusters/folly/apps/spindrift-target/`.

## Write the installation Secret

`secret.sops.yaml` is the Secret `spindrift-env`.

| Key | Value |
| --- | --- |
| `SPINDRIFT_ENROLMENT_TOKEN` | Claims the installation |
| `SPINDRIFT_CREDENTIAL_KEYRING` | Encrypts stored credentials |
| `SPINDRIFT_GITHUB_APP_ID`, `SPINDRIFT_GITHUB_APP_PRIVATE_KEY`, `SPINDRIFT_GITHUB_WEBHOOK_SECRET` | Optional. Adopts a GitHub App |
| `SPINDRIFT_VERCEL_TOKEN`, `SPINDRIFT_CLOUDFLARE_TOKEN` | Optional. Vercel and Cloudflare Pages tokens |

> [!WARNING]
> A copied enrolment token lets its holder claim the installation. Make a new token for each installation.

> [!WARNING]
> The chart keeps the CNPG Cluster `spindrift-db` after an uninstall. A new keyring cannot open the credentials in it.

1. Find out if the database exists.

   ```bash
   kubectl --context offsite -n spindrift get cluster.postgresql.cnpg.io spindrift-db
   ```

   Result: `NotFound` for a new installation.

> [!WARNING]
> Steps 2 and 3 print secrets. Do not run them through an agent or in a logged terminal.

2. If the database does not exist, make a keyring.

   ```bash
   bun -e "const k=require('crypto').randomBytes(32).toString('base64url');console.log(JSON.stringify({active:'k1',keys:{k1:k}}))"
   ```

   If it exists, keep the keyring. To rotate it, add a new `active` key and keep the others.

   Result: A JSON line with `active` and `keys`.

3. Make an enrolment token.

   ```bash
   bun -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

   Result: A 43-character base64url string.

4. Open the Secret in your editor.

   ```bash
   SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops clusters/offsite/apps/spindrift/secret.sops.yaml
   ```

5. Set each key under `stringData`. Save the file and close the editor.

   Result: sops encrypts the file again.

6. Open a pull request with these changes.

## Apply the OpenTofu roots

The roots `terraform/gcp/projects/bluenose/` and `terraform/gcp/projects/trusted-builds/` need resources from each other. Apply them in three phases.

1. Comment `atlantis plan -d terraform/gcp/projects/trusted-builds` on the pull request.

   Result: Atlantis comments the plan.

> [!CAUTION]
> On a new installation, the first trusted-builds apply fails with HTTP 400, because bluenose has no `spindrift-controller` service account yet.

2. Comment `atlantis apply -d terraform/gcp/projects/trusted-builds`.

   Result: The controller grants fail. The apply creates the attestor and imports the KMS keys.

3. Do steps 1 and 2 for `terraform/gcp/projects/bluenose`.

   Result: The apply creates `spindrift-controller`.

4. Do steps 1 and 2 for `terraform/gcp/projects/trusted-builds` again.

   Result: Atlantis merges the pull request.

## Make sure the installation runs

1. Make sure the installation is ready.

   ```bash
   flux --context offsite get sources oci -n spindrift
   flux --context offsite get helmreleases -n spindrift
   kubectl --context offsite -n spindrift get cluster.postgresql.cnpg.io spindrift-db
   kubectl --context offsite -n spindrift get deploy,job
   ```

   Result: `READY` is `True`, the Cluster is healthy, the `spindrift-migrate-*` Job is `Complete`, and then both Deployments are `1/1`.

## Enrol the first passkey

> [!NOTE]
> The enrolment token works once. A new token replaces every passkey and ends every session.

1. Open `https://<hostname>`.

   Result: "Claim this installation", or "Sign in" if the database existed.

2. If the page shows "Sign in", sign in with your passkey. Skip steps 3 to 8.
3. Enter the value of `SPINDRIFT_ENROLMENT_TOKEN`.
4. Select "Enrol a passkey".
5. Register the passkey when the browser asks.

   Result: The onboarding wizard opens.

6. If you have a file from "Download this installation" in Settings, select "Restore from a file".
7. Complete the wizard.

   For "Where artifacts are published", use `registry` from the `supply_chain_manifest_block` output in the last trusted-builds apply comment.

8. Select "Configure this installation".

   Result: The page shows "This installation is configured."

## Connect GitHub and Targets

1. If Repositories shows "Create the App on GitHub", select it. Create the App on GitHub.
2. If you adopt an App, select "Active" under Webhook in its GitHub settings.

   Use `https://<public-hostname>/internal/github/webhook` and `SPINDRIFT_GITHUB_WEBHOOK_SECRET`.

> [!CAUTION]
> A private GitHub App installs only on its owner account. A public App cannot become private while another account has it installed.

3. If a repository belongs to another account, select "Make public" in the App's Advanced settings.
4. Select "Install on GitHub". Connect each repository in Repositories and each Target in Targets.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| A Target call fails with `unable to get issuer certificate`. | `ca-bundle.yaml` lacks part of that chain. | Run `nix develop -c bash scripts/pki/post-rotate.sh folly offsite`. Commit and merge the output ([PKI](../platform/pki.md)). |
| A credential fails with "cannot be opened by this keyring". | The keyring lost its key. | Restore that key. |
| You cannot sign in. | The passkey is lost. | Rotate `SPINDRIFT_ENROLMENT_TOKEN` and merge. Select "Recover with a rotated token". |

## Related

- [Built apps](../apps/kthx/built-apps.md)
- [Ownership and security](../apps/kthx/security.md)
- [Operate Postgres](operate-postgres.md)
- [Connect an agent to kthx](connect-an-agent-to-kthx.md)
