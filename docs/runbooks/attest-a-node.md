---
title: Attest a node
description: Attest a folly node's TPM and boot chain from HookOS through talos-attest, so that it gets an LDevID, with no wipe, started by a pull request.
---

Use this runbook to attest a folly node that has Intel AMT and a TPM 2.0, and to give its TPM an LDevID for SPIRE. A pull request adds a `Workflow`. [Tinkerbell](../platform/nixos/tinkerbell.md#boot-path) power-cycles the node into HookOS, which runs the `attest-to-disk` Template, and the node reboots to its installed system. [talos-attest](../apps/talos-attest.md) describes the checks.

`<node>` is the host name, `<serial>` its `serial` in `clusters/folly/inventory/machines.yaml`, and `<anchor>` an anchor's host name.

## Before you start

- talos-attest runs on the anchors. Read [Turn talos-attest on](#turn-talos-attest-on) once.
- The `attest-to-disk` Template pins a delivered `tink-attest` digest, not all zeros.
- The node's Rufio `Machine` is contactable, and its firmware boots the disk first and IPv4 PXE after it, as [Reprovision a Talos node](reprovision-a-talos-node.md#before-you-start) describes.
- The node runs with our Secure Boot keys enrolled and Secure Boot on.
- You can see the node's console, and you are on the tailnet as a login in `ATTEST_APPROVERS`.

> [!CAUTION]
> The run reboots the node twice. Move workloads that cannot stop, such as a database primary, off the node first.

## Turn talos-attest on

1. Comment `atlantis apply` on the pull request that adds `terraform/pki/devid.tf`.

   Result: Atlantis applies the DevID CA and merges the pull request.

2. On a branch from `main`, seal the CA key and commit the chain.

   ```bash
   SOPS_AGE_KEY_FILE=~/.config/age/keys.txt bash scripts/pki/devid-ca.sh
   mise run pki:verify
   ```

   Result: `ok`, and changes to `terraform/pki/certs/` and the three anchors' sops files.

3. Merge the pull request, and deploy capsule, forge and spore, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.
4. Make sure that each anchor serves.

   ```bash
   ssh <anchor>.lolwtf.ca systemctl is-active talos-attest
   ```

   Result: `active`.

## Run the attestation

1. Move the node to the bootstrap VLAN: set `enrolled.<node>` to `"bootstrap"` in `terraform/network/unifi/folly/bootstrap.tf`, and apply it through Atlantis.
2. On a branch, create `clusters/folly/tinkerbell/attest-<node>.yaml`.

   ```yaml
   apiVersion: tinkerbell.org/v1alpha1
   kind: Workflow
   metadata:
     name: attest-<node>
     labels:
       tinkerbell.lolwtf.ca/template: attest
   spec:
     hardwareRef: <node>
   ```

3. Add `attest-<node>.yaml` to `resources` in `clusters/folly/tinkerbell/kustomization.yaml`, and open a pull request.
4. Merge the pull request, and reconcile the Kustomization.

   ```bash
   flux --context folly reconcile kustomization tinkerbell --with-source
   ```

   Result: `applied revision` with the merge commit.

5. Watch the `Workflow`.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get workflow attest-<node> -w
   ```

   Result: `RUNNING` through `attest`, `disk-next` and `reboot`, then `SUCCESS`. The console shows `attest: PASSED`.

6. Read the verdict.

   ```bash
   curl -s http://<anchor>.lolwtf.ca:8444/verdict/<serial>
   ```

   Result: `"status":"attested"`.

7. Set `enrolled.<node>` back to `"kubernetes"`, and apply it through Atlantis.
8. Remove `attest-<node>.yaml` and its `resources` entry in a pull request, and merge it.

## Approve a first intake

If the console shows `pending-approval`, no pin names the node's EK. The EK hash goes to NetBox after the pass.

1. Approve the hashes on the anchor that holds the boot VIP.

   ```bash
   curl -s -X POST https://<anchor>.<tailnet>:8445/approve -d '{"serial":"<serial>"}'
   ```

   Result: JSON with `approved` and the EK hashes.

2. Rename the `Workflow`, for example to `attest-<node>-2`, and merge it.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `attest: FAILED: refused (403): quarantine policy: ...` | The event log breaks `policy.yaml` | Read the violation. A new signed iPXE or HookOS needs no policy change unless `boot_applications` is set. |
| `quarantine ek-chain` or `ek-hash-mismatch` | A TPM from an unpinned maker, or a pin for another TPM | Compare the EK hashes in `GET /machines` with NetBox and `machines.yaml`. |
| `open /dev/tpmrm0` or `event log` errors | HookOS shows no TPM or no securityfs | Read the action's log in the `Workflow`, and `dmesg` on the console. |
| `connection refused` to the boot VIP | talos-attest is down on the VIP's holder | Read `journalctl -u talos-attest` on that anchor. |
| The other symptoms of a Tinkerbell run | See [Reprovision a Talos node](reprovision-a-talos-node.md#if-something-goes-wrong) | Follow its table. |

## Related

- [talos-attest](../apps/talos-attest.md)
- [Identity](../platform/identity.md)
- [Add a TPM node to SPIRE](add-a-tpm-node-to-spire.md)
- [Reprovision a Talos node](reprovision-a-talos-node.md)
