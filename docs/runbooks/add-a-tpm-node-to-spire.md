---
title: Add a TPM node to SPIRE
description: Admit a folly node with a TPM 2.0 to spore's SPIRE server by its LDevID, or by its endorsement key hash as the fallback, and make sure its agent serves SVIDs.
---

Use this runbook to give a folly node with a TPM 2.0 a SPIRE agent, to turn on LDevID attestation, and to turn on the notifier that keeps the agents' bootstrap bundle current. [Identity](../platform/identity.md) describes the agent, both node attestors and the SPIFFE IDs.

A node that passed attestation has an LDevID from the attest service, and its agent attests with it. The endorsement key (EK) hash allow list is the fallback for a node with no LDevID.

`<name>` is the node's host name, and `<hash>` is its EK hash.

## Before you start

- You need the `folly` context with cluster admin, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- You need a root shell on spore.
- To turn on the bundle notifier, you need the operator key in `~/.config/age/keys.txt`, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
- The node is in folly, and its TPM 2.0 is on in the firmware.
- The GHCR package `ghcr.io/jonpulsifer/spire-agent-tpm` is public.
- To admit the node by LDevID, LDevID attestation is on, and the node passed attestation.

## Admit the node

spore builds the EK hash allow list and the EK aliases from `ekHashes` in `nix/hosts/spore.nix`, and the LDevID aliases from `clusters/folly/inventory/machines.yaml`. It registers the entries in `workloads` under each alias.

1. Make sure that `machines.yaml` on `main` lists the node with `tpm: "2.0"` and the status `staged` or `active`. NetBox's export writes it.
2. If the node has no LDevID, read its EK hash, and on a branch add `<name> = "<hash>";` to `ekHashes`.
3. In `clusters/folly/talos/talos.tf`, give the node the label `lolwtf.ca/tpm` with the value `true`.
4. Open a pull request, and apply it with Atlantis.
5. Deploy spore from `main`, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.

## Turn on LDevID attestation

Do this once. The server then runs `tpm_devid` beside the EK attestor, and each agent attests by LDevID when the attest service serves one for its node.

1. On a branch, in `homelab.spire` of `nix/hosts/spore.nix`, list each `folly-devid-ca-<name>.pem` of `terraform/pki/certs/` in `devid.caChains`.
2. Set `devid.enable = true;`.
3. Merge the pull request, and deploy spore.
4. In a second pull request, set `ATTEST_URL` in the `spire-attest` ConfigMap of `clusters/folly/apps/spire/agent-config.yaml`.

   The value is the attest service's base URL on the Anchor network.

5. Merge the pull request.

   Result: Reloader restarts the agents.

6. Read the attestation of each agent, as [Make sure the agent serves SVIDs](#make-sure-the-agent-serves-svids) describes.

   Result: `spiffe_id="spiffe://lolwtf.ca/spire/agent/tpm_devid/<fingerprint>"`.

> [!CAUTION]
> With no EK hash left, the server has no EK attestor. An agent whose LDevID fetch fails then cannot attest.

7. When every node attests by LDevID, delete each entry of `ekHashes`, and deploy spore.

## Read the EK hash

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because only a privileged process on the node can read the TPM. The debug pod reads the EK hash, and you delete it at once.

1. Start a privileged debug pod on the node, and print the hash.

   ```bash
   kubectl --context folly -n spire debug node/<name> --profile=sysadmin \
     --image=ghcr.io/jonpulsifer/spire-agent-tpm:latest -it -- /opt/spire/plugins/get_tpm_pubhash
   ```

   Result: one line of 64 lowercase hexadecimal characters.

2. Find the debug pod.

   ```bash
   kubectl --context folly -n spire get pods
   ```

   Result: a pod named `node-debugger-<name>-<suffix>`.

3. Delete the debug pod.

   ```bash
   kubectl --context folly -n spire delete pod node-debugger-<name>-<suffix>
   ```

## Turn on the bundle notifier

Do this once, before the first agent attests. spore's `k8sbundle` notifier then writes the server's bundle into `spire-bundle` at startup and on every CA rotation. It signs in to folly as the ServiceAccount `spire-bundle-writer` in `clusters/folly/apps/spire/bundle-writer.yaml`.

> [!NOTE]
> The cluster Secret `spire-bundle-writer-token` is the source of the token, so it has no 1Password item. If the Secret is made again, its token changes.

1. Make sure that Flux has filled the token.

   ```bash
   kubectl --context folly -n spire get secret spire-bundle-writer-token -o jsonpath='{.data.token}' | wc -c
   ```

   Result: a number larger than zero.

2. On a branch, put the token in spore's SOPS file. The pipe prints nothing.

   ```bash
   export SOPS_AGE_KEY_FILE=~/.config/age/keys.txt
   kubectl --context folly -n spire get secret spire-bundle-writer-token -o jsonpath='{.data.token}' | base64 -d \
     | jq -Rs . | sops set --value-stdin nix/secrets/spore.sops.yaml '["spire"]["folly-bundle-writer-token"]'
   ```

3. Make sure that the new value is encrypted.

   ```bash
   grep -A1 '^spire:' nix/secrets/spore.sops.yaml | grep -c 'ENC\['
   ```

   Result: `1`.

4. In `nix/hosts/spore.nix`, set `homelab.spire.bundleNotifier.enable = true;`.
5. Merge the pull request, and deploy spore, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.
6. Make sure that the ConfigMap holds the bundle.

   ```bash
   kubectl --context folly -n spire get cm spire-bundle -o jsonpath='{.data.bundle\.crt}' | grep -c 'BEGIN CERTIFICATE'
   ```

   Result: `1` or more.

## Make sure the agent serves SVIDs

1. Find the agent pod on the node.

   ```bash
   kubectl --context folly -n spire get pods -o wide
   ```

   Result: a `spire-agent` pod on `<name>` with the status `Running`.

2. Read the attestation in its log.

   ```bash
   kubectl --context folly -n spire logs <pod> | grep 'Node attestation was successful'
   ```

   Result: a line with `spiffe_id="spiffe://lolwtf.ca/spire/agent/tpm_devid/<fingerprint>"`, or `spiffe_id="spiffe://lolwtf.ca/spire/agent/tpm/<hash>"` for the EK attestor.

3. If the agent attests by EK hash and you expect its LDevID, read the init container's log.

   ```bash
   kubectl --context folly -n spire logs <pod> -c devid-init
   ```

   Result: a line with `"attestor":"tpm_devid"`, or a warning that names the reason for the fallback.

4. On spore, list the agents.

   ```bash
   spire-server agent list -socketPath /run/spire/server/private/api.sock
   ```

   Result: the agent ID of step 2.

5. If the Job in `clusters/folly/apps/spire/smoke.yaml` has `suspend: true`, remove that line in a pull request, and merge it. Only the first node needs this step.
6. Read the smoke Job's log.

   ```bash
   kubectl --context folly -n spire-smoke logs job/spire-smoke
   ```

   Result: `SPIFFE ID: spiffe://lolwtf.ca/ns/spire-smoke/sa/smoke`.

> [!NOTE]
> The Job reruns every one to two hours. If the log is empty, wait for the next run.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| No `spire-agent` pod on the node | The node has no `lolwtf.ca/tpm=true` label | Add the label in the Talos root. |
| The pod shows `ImagePullBackOff` | The GHCR package is private, or the DaemonSet pins no built digest | Make the package public, or merge the digest pull request. |
| The agent fails to start with a trust bundle error | `spire-bundle` is empty, because the notifier is off | Turn on the bundle notifier. |
| The first attestation fails with `x509: certificate signed by unknown authority` | The notifier missed a rotation while folly's API server was down | On spore, run `systemctl restart spire-server`. The notifier writes the bundle at startup. |
| `spire-server` restarts every 30 seconds, and its journal shows `Notifier failed to handle event` | The server cannot write the bundle at startup, and it exits | If the error is `401`, the Secret is new: store its token again. Otherwise, make sure that spore reaches folly's API server. |
| The server rejects the attestation | The hash is not in `ekHashes` of `nix/hosts/spore.nix`, or spore runs an older configuration | Add the hash, and deploy spore. |
| `devid-init` logs `no usable LDevID` | The attest service is unreachable, holds no LDevID for the serial, or serves one for another node, serial or key | Read the reason in the log. Attest the node again, or fix `ATTEST_URL`. |
| The agent logs `tpm2.Load failed` | The attest service wrapped the LDevID key under another parent than the TCG H-1 or H-2 storage root key | Attest the node again after the attest service creates the key under that parent. |
| The server logs `cannot verify EK signature` | The CA that signed the node's EK certificate is not in `nix/services/spire/roots/` | Add the CA from the EK certificate's AIA URL, and deploy spore. |
| The agent logs `unable to get endorsement certificate` | The TPM has no RSA EK certificate in NV, which `tpm_devid` reads | Admit the node by EK hash. |
| The agent attests by LDevID, and workloads get no SVID | No alias selects the LDevID's subject CN | Make sure that `machines.yaml` lists `<name>` with `tpm: "2.0"` and the status `staged` or `active`, that `devid.enable` is on, and that spore runs that commit. |
| `TalosAttestLDevIDExpiring` fires | `tpm-reattest` on the node cannot renew the LDevID | Read `kubectl --context folly -n spire logs daemonset/tpm-reattest`, or the pod on `<name>`. A `404` refusal means the service has no LAK for the serial, and a `403` means the machine's status forbids a renewal. Otherwise, attest the node again. |
| The debug pod prints a TPM open error | The TPM is off in the firmware | Turn on the TPM, and boot the node. |
| The smoke Job runs no pod | The Job is suspended | Remove `suspend: true` from `clusters/folly/apps/spire/smoke.yaml`. |
| The smoke Job prints `no identity issued` | No entry for `spire-smoke/smoke` has the node's alias as parent | Add the pair to `workloads` in `nix/hosts/spore.nix`, and deploy spore. |
| The agent logs `403` from the kubelet | The `spire-agent` ClusterRole lacks `nodes/pods` | Read `clusters/folly/apps/spire/rbac.yaml`. |
