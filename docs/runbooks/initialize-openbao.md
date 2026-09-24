---
title: Initialize OpenBao
description: Initialize a new OpenBao instance on folly, store its recovery key and root token, and make sure it unseals itself.
---

OpenBao is a secrets server on folly, and no workload reads from it. It must be unsealed to read its encrypted storage, and it unseals itself with a GCP KMS key. Use this runbook when OpenBao starts with an empty storage volume, for example after the volume is lost. [Secrets](../platform/secrets.md#openbao) describes the instance.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because `bao operator init` makes the recovery key and root token, and git cannot hold them.

## Before you start

- You need the `folly` context in `kubectl`.
- The pod `vault-openbao-0` shows `Running` in `kubectl --context folly -n vault get pods`. It is not ready until it is unsealed.
- You have a 1Password item in the `homelab` vault for the recovery key and the root token.

## Initialize the instance

1. Show the status of the instance.

   ```bash
   kubectl --context folly -n vault exec vault-openbao-0 -- bao status
   ```

   Result: The `Initialized` row shows `false`.

> [!NOTE]
> An initialized instance has data. This procedure is for an empty instance.

2. If the `Initialized` row shows `true`, stop.

> [!WARNING]
> The next command shows the only copy of the recovery key and the root token. Do not run it through an agent, or in a terminal that logs its output.

3. Initialize the instance.

   ```bash
   kubectl --context folly -n vault exec -it vault-openbao-0 -- bao operator init -recovery-shares=1 -recovery-threshold=1
   ```

   Result: The command prints `Recovery Key 1` and `Initial Root Token`.

4. Put the recovery key and the root token in the 1Password item.
5. Clear the terminal and its scrollback.
6. Make sure that the instance is unsealed. Do step 1 again.

   Result: The `Initialized` row shows `true`, and the `Sealed` row shows `false`.

## Make sure a restart unseals the instance

1. Delete the pod. The StatefulSet starts a new pod.

   ```bash
   kubectl --context folly -n vault delete pod vault-openbao-0
   ```

   Result: The command prints `pod "vault-openbao-0" deleted`.

2. Wait for the new pod to become ready.

   ```bash
   kubectl --context folly -n vault wait --for=condition=Ready pod/vault-openbao-0 --timeout=5m
   ```

   Result: The command prints `pod/vault-openbao-0 condition met`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `bao operator init` fails with `already initialized`. | The instance has data. | Stop. Do not initialize the instance. |
| The pod does not become ready after a restart. | The pod cannot use the GCP KMS key `openbao`. | Read the pod log. Make sure that `curl -fsS https://oidc.lolwtf.ca/folly/.well-known/openid-configuration` prints JSON. |
| The pod log shows a permission error from GCP. | The GCP service account `vault-id` has no grant on the key. | Apply `terraform/gcp/projects/homelab-ng/`, as [Apply an OpenTofu change](apply-an-opentofu-change.md) describes. |

## Related

- [Secrets](../platform/secrets.md#openbao): the instance and what it depends on.
- [PKI](../platform/pki.md#workload-identity): how the pod gets a GCP credential.
