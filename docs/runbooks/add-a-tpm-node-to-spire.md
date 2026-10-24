---
title: Add a TPM node to SPIRE
description: Read a folly node's TPM endorsement key hash, admit it on spore's SPIRE server, label the node, and make sure its agent serves SVIDs.
---

Use this runbook to give a folly node with a TPM 2.0 a SPIRE agent, and to refresh the agents' bootstrap bundle. [Identity](../platform/identity.md) describes the agent, the SPIFFE IDs and the endorsement key (EK) hash allow list.

`<name>` is the node's host name, and `<hash>` is its EK hash.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because only a privileged process on the node can read the TPM. The debug pod reads the EK hash, and you delete it at once.

## Before you start

- You need the `folly` context with cluster admin, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- You need a shell on spore where `spire-server` reaches the server.
- The node is in folly, and its TPM 2.0 is on in the firmware. On optiplex, Intel PTT is the TPM.
- The GHCR package `ghcr.io/jonpulsifer/spire-agent-tpm` is public.

## Read the EK hash

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

## Admit the node

1. On a branch, add an empty file named `<hash>` to `clusters/base/spire/ek/`. spore's SPIRE server reads that directory as its EK hash allow list.
2. To spore's registration entries, add the node alias entry `spiffe://lolwtf.ca/node/<name>` with the selector `tpm:pub_hash:<hash>`.
3. For each workload that the node must serve, add an entry with the new alias as its parent. Include `spire-smoke/smoke`.
4. In `clusters/folly/talos/talos.tf`, give the node the label `lolwtf.ca/tpm` with the value `true`.
5. Open a pull request, and apply it with Atlantis.
6. Deploy spore, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.

## Refresh the bootstrap bundle

Do this before the first agent attests, and before you add a node.

> [!NOTE]
> The bundle holds public certificates, so the repository can hold it.

1. On spore, print the server's bundle.

   ```bash
   spire-server bundle show -format pem
   ```

   Result: one or more `CERTIFICATE` blocks.

2. Put the output in `bundle.crt` of `clusters/folly/apps/spire/bundle.yaml`.
3. Merge the pull request. Flux applies the ConfigMap, and Reloader restarts the agents.

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

   Result: a line with `spiffe_id="spiffe://lolwtf.ca/spire/agent/tpm/<hash>"`.

3. On spore, list the agents.

   ```bash
   spire-server agent list
   ```

   Result: the agent ID of step 2.

4. If the Job in `clusters/folly/apps/spire/smoke.yaml` has `suspend: true`, remove that line in a pull request, and merge it. Only the first node needs this step.
5. Read the smoke Job's log.

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
| The agent fails to start with a trust bundle error | `spire-bundle` is empty | Refresh the bootstrap bundle. |
| The first attestation fails with `x509: certificate signed by unknown authority` | The server's CA is newer than the committed bundle | Refresh the bootstrap bundle. |
| The server rejects the attestation | No file named the hash is in `clusters/base/spire/ek/`, or spore runs an older configuration | Add the file, and deploy spore. |
| The debug pod prints a TPM open error | The TPM is off in the firmware | Turn on the TPM or PTT, and boot the node. |
| The smoke Job runs no pod | The Job is suspended | Remove `suspend: true` from `clusters/folly/apps/spire/smoke.yaml`. |
| The smoke Job prints `no identity issued` | No entry for `spire-smoke/smoke` has the node's alias as parent | Add the entry, and deploy spore. |
| The agent logs `403` from the kubelet | The `spire-agent` ClusterRole lacks `nodes/pods` | Read `clusters/folly/apps/spire/rbac.yaml`. |
