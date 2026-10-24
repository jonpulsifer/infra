---
title: Build the signed Talos images
description: Run the Talos image pipeline for folly, and check the signed installer, ISO and HTTP-boot UKI that it publishes.
---

Use this runbook to build folly's signed Talos boot assets on demand, or to check a build that a push to `main` started. `.github/workflows/talos-images.yml` runs the siderolabs imager with the Secure Boot keys from 1Password. It pushes the installer to GHCR and attaches the ISO and the UKI to a GitHub release. [Kubernetes](../platform/kubernetes.md#signed-talos-images) says what each output is for.

## Before you start

- You need `gh` signed in to `jonpulsifer/infra`, a checkout of the repo, and `openssl`, `sbsigntool` and `osslsigncode`.
- You need a 1Password service account that can read the item `talos-secureboot` in the `homelab` vault.
- `<version>` is `talos_version` in `clusters/folly/talos/talos.tf`.

## Give the pipeline its keys

Do this once. Without the secret, the workflow builds nothing and logs a warning.

1. Store the service account's token as a repository secret.

   ```bash
   gh secret set OP_SERVICE_ACCOUNT_TOKEN --repo jonpulsifer/infra
   ```

   Result: `Set Actions secret OP_SERVICE_ACCOUNT_TOKEN for jonpulsifer/infra`.

## Run the build

> [!CAUTION]
> A run replaces the installer tag and the release assets of `<version>`. A node that installs during the run can pull either build.

1. Start the workflow on `main`.

   ```bash
   gh workflow run talos-images.yml --repo jonpulsifer/infra --ref main
   ```

2. Watch the newest run.

   ```bash
   gh run watch --repo jonpulsifer/infra \
     "$(gh run list --repo jonpulsifer/infra --workflow talos-images.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

   Result: The jobs `inputs` and `build` finish with success. The run summary shows the UKI command line and the installer digest.

## Check the outputs

1. Make sure the installer package is public, so that a node pulls it with no credentials.

   ```bash
   gh api /users/jonpulsifer/packages/container/talos-installer-folly --jq .visibility
   ```

   Result: `public`.

2. If the result is `private`, change the package visibility to public in its settings on GitHub.

3. Download the UKI and the ISO.

   ```bash
   gh release download talos-folly/<version> --repo jonpulsifer/infra --dir /tmp/talos-folly
   ```

4. From the root of the checkout, make sure the UKI verifies against the committed certificate. This is the check that the workflow runs before it publishes.

   ```bash
   bash .github/scripts/talos-uki-verify.sh clusters/folly/talos/secureboot/uki-signing-cert.pem /tmp/talos-folly/metal-amd64-secureboot-uki.efi
   ```

   Result: `/tmp/talos-folly/metal-amd64-secureboot-uki.efi: signed by subject=..., image hash ...`.

> [!NOTE]
> Plain `sbverify --cert` reports `Signature verification failed` for this certificate. The certificate's extended key usage is serverAuth and clientAuth, with no codeSigning. UEFI firmware ignores that usage, and the script checks the signature with any purpose.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The run warns that `OP_SERVICE_ACCOUNT_TOKEN` is not set. | The repository secret is missing. | Do [Give the pipeline its keys](#give-the-pipeline-its-keys), then run the build. |
| The step `Load the signing keys` fails. | The service account cannot read the item, or a file label differs. | Make sure the item has the files `uki_signing_key`, `uki_signing_cert` and `pcr_signing_key`, and that the account can read the vault. |
| The run fails with `the 1Password certificate is not the committed one`. | The item and `clusters/folly/talos/secureboot/` hold different keys. | Find which side changed. Commit the item's public halves only if its keys are the intended ones. |
| The run fails with `want one image in ghcr.io/siderolabs/extensions`. | Talos builds no extension of that name for this version. | Correct the name in `extensions` in `talos.tf`. |
| `talos-uki-verify.sh` fails on the downloaded UKI. | The workflow verifies each UKI before it uploads it, so the asset is not what the newest `main` run built, or the checkout's certificate differs from that build's. | Compare the commit in the release notes with your checkout and with the run that last uploaded the asset. Do not run the build again until you know which side changed. |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [PKI](../platform/pki.md)
- [Install Talos on a node](install-talos-on-a-node.md)
