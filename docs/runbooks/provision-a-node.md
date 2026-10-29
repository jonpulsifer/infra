---
title: Provision a node
description: Declare a prepared folly machine in NetBox and install it as a Talos worker through its desired_action.
---

Use this runbook to install a new folly node through [NetBox](../platform/netbox.md). Its `desired_action` starts a [fleet-controller](../apps/fleet-controller.md) run; [talos-attest](../apps/talos-attest.md) attests it, and [Talos enrollment](../apps/talos-enroll.md) releases its config. [Identity](../platform/identity.md#lifecycle) lists the statuses.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because NetBox holds each machine's lifecycle.

## Before you start

- A new machine is ready, as [Prepare a machine](prepare-a-machine.md) describes.
- You can sign in to NetBox at `https://capsule.<tailnet>`.
- You are a tailnet login in `ENROLL_APPROVERS` and `ATTEST_APPROVERS`, and you can read Discord and the console.
- `<node>` is the host name, `<serial>` the SMBIOS serial, and `<addr>` a free address in `K8S_NODE_CIDR` of `clusters/folly/config/cluster-topology.json`.

## Declare the device

1. In NetBox, add a device at the site `folly` with the role `kubernetes-node` and the status `planned`.
2. Set its name, serial, device type, `talos_class`, `bmc_type`, `install_disk`, `tpm_version`, `amt` and `secure_boot_expected`.
3. Give its first interface the MAC as its primary MAC, and cable it to the node's switch port.
4. Set its primary IPv4 to `<addr>`. If `bmc_type` is `redfish`, set its out-of-band IP.
5. If you know the EK hashes, set `ek_hash` and `ek_hash_ecc`.

## Provision a new node

A `planned` device has no RADIUS user, so the machine and its AMT start on the bootstrap network, and you power it on by hand. `mise run netbox:check` fails unless `NODE_ADDRESSES` names every staged, active and failed node that has a primary IPv4, at that address, and no other node. So `NODE_ADDRESSES` cannot name a `planned` device.

1. Connect the machine to its switch port.
2. In NetBox, set the device's `desired_action` to `provision`.

   Result: within two minutes, `last_workflow` names `provision-<node>-<unix seconds>`. The status stays `planned`, and the journal says to power the machine on.

3. Power on the machine. Its empty disk falls through to IPv4 network boot, and iPXE chains HookOS.
4. [Watch the run](#watch-the-run). If every EK has a certificate from a pinned maker, no approval is needed. Otherwise, pin the EK or [approve the first intake](#approve-a-first-intake).

   Result: talos-attest sets the device to `staged`.

5. On a branch, run `mise run netbox:export`. Add `"<node>": "<addr>"` to `NODE_ADDRESSES`.
6. Make sure that `mise run netbox:check` prints nothing. Open a pull request.
7. Comment `atlantis apply -d terraform/network/unifi/folly`.

   Result: the node has a RADIUS user, a DHCP reservation and a DNS record.

8. If the node installed on the bootstrap network, power-cycle it, so that the switch runs MAC auth again. AMT then answers at `<addr>`, and Rufio drives later runs.
9. Comment `atlantis plan -d clusters/folly/talos`, then `atlantis apply`.
10. [Deploy spore](deploy-a-nixos-host.md) from `main`. spore then has a SPIRE alias for the node's LDevID.
11. Make sure that the node is Ready, that `talosctl --nodes <addr> get securitystate` shows `secureBoot: true`, and that its [SPIRE agent](add-a-tpm-node-to-spire.md#make-sure-the-agent-serves-svids) attests by LDevID.
12. If the merged export shows the node `staged`, export again in a pull request, and apply `clusters/folly/talos`.

## Watch the run

1. Watch the `Workflow`.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get workflows -w
   ```

   Result: `RUNNING` through `set-clock`, `attest`, `wipe-disk`, `next-boot` and `reboot`, then `SUCCESS`.

2. Watch the console and NetBox.

   Result: `attest: PASSED`, and `attest_verdict` `attested`. The node netboots the Talos UKI.

3. Watch the Discord prompt.

   Result: `auto-approved after attestation`, then `<node> fetched its config`. NetBox shows `active`.

4. If the prompt waits for approval, run `mise run enroll:approve <code> <node>` with the console's code. A `worker-g2` node always waits.

## Approve a first intake

With no pin, the console shows `attest: FAILED` with `pending-approval`, and the `Workflow` fails before the wipe.

> [!CAUTION]
> A waiting claim proves nothing, because another machine can send one with this serial. Approve only hashes that you read on the console.

1. Read the EK hashes on the console, as `rsa:<hash>` and `ecc:<hash>`.
2. Run `mise run attest:approve <serial>`.

   Result: the claim and a question.

3. If the hashes match the console, answer `y`.
4. Set `desired_action` to `provision` again. The pass writes the hashes to `ek_hash` and `ek_hash_ecc`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `desired_action` stays set | fleet-controller is down, or the device lacks a MAC or `install_disk` | Read the device's journal and `journalctl -u fleet-controller` on spore |
| The `Workflow` stays `PREPARING` with `BootJobFailed` | Rufio cannot reach the BMC | Read the `Machine`'s conditions |
| `attest: FAILED` with `quarantine` | The boot breaks `apps/talos-attest/policy.yaml`, and NetBox shows `failed` | Fix the boot chain, then set the status to `staged` |
| Approval answers 400 or 409 | The device lacks `talos_class`, or `class-inputs.json` lacks the class | Set the class, or run `mise run render-class-inputs` |

## Related

- [Prepare a machine](prepare-a-machine.md)
- [Reprovision a node](reprovision-a-node.md)
- [Retire a node](retire-a-node.md)
- [Hardware inventory](../reference/inventory.md)
