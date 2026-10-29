---
title: Provision a node
description: Declare a prepared folly machine in NetBox and install it as a Talos worker through its desired_action.
---

Use this runbook to install a new folly node through [NetBox](../platform/netbox.md). Its `desired_action` starts a [fleet-controller](../apps/fleet-controller.md) run. [talos-attest](../apps/talos-attest.md) attests the node, and the controller releases its config. [Identity](../platform/identity.md#lifecycle) lists the statuses.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because NetBox holds each machine's lifecycle.

## Before you start

- A new machine is ready, as [Prepare a machine](prepare-a-machine.md) describes.
- You can sign in to NetBox at `https://capsule.<tailnet>`.
- You are a tailnet login in `ATTEST_APPROVERS`, and you can read the console.
- `<node>` is the host name, `<serial>` the SMBIOS serial, and `<addr>` a free address in `K8S_NODE_CIDR` of `clusters/folly/config/cluster-topology.json`.

## Declare the device

Read the serial and the MAC from the HP label, and the port from the rack. On a branch, run:

```sh
mise run netbox:declare <node> <serial> <mac> <switch port> <addr>
```

The command refuses a name that is not a hostname, a malformed MAC, a port the switch lacks, and an address outside `K8S_NODE_CIDR`, in `NODE_ADDRESSES` or on another device. It declares the device as `planned` with the role `kubernetes-node` and the platform `talos`. Its first interface gets the MAC as its primary MAC, a cable runs to the port, and `<addr>` is its primary IPv4. The defaults are the G5 mini: `--class worker-g5`, `--bmc amt`, `--disk /dev/nvme0n1` and `--type hp-elitedesk-800-g5-desktop-mini`. A second run with the same facts changes nothing, and a different serial or MAC for an existing name is refused.

Then it runs `mise run netbox:export` and prints the diff of `clusters/folly/inventory/machines.yaml`. Commit that file and open the export pull request.

If you know the EK hash, add `--ek-hash <hex>`; set `ek_hash_ecc` in NetBox. If `bmc_type` is `redfish`, set the out-of-band IP in NetBox.

## Provision a new node

A `planned` device with a MAC and a switch port gets a RADIUS user on the Kubernetes network and a DHCP reservation from its export once that export is applied; until then it sits on the bootstrap fallback, so you power it on by hand. `mise run netbox:check` fails unless `NODE_ADDRESSES` names every staged, active and failed node that has a primary IPv4, at that address, and no other node. So `NODE_ADDRESSES` cannot name a `planned` device.

1. Connect the machine to the prep station's port, `provisioning` in `quarantine_ports`. That port is always on the bootstrap network, so the whole intake (key enrollment, attest, install and first boot) runs there. The move to its switch port comes after, at step 8.
2. In NetBox, set the device's `desired_action` to `provision`.

   Result: within two minutes, `last_workflow` names `provision-<node>-<unix seconds>`. The status stays `planned`.

3. Power on the machine. Its empty disk falls through to IPv4 network boot, and iPXE chains HookOS.
4. [Watch the run](#watch-the-run). If every EK has a certificate from a pinned maker, no approval is needed. Otherwise, pin the EK or [approve the first intake](#approve-a-first-intake).

   Result: talos-attest sets the device to `staged`.

5. On a branch, run `mise run netbox:export`. Add `"<node>": "<addr>"` to `NODE_ADDRESSES`.
6. Make sure that `mise run netbox:check` prints nothing. Open a pull request.
7. Comment `atlantis apply -d terraform/network/unifi/folly`.

   Result: the node has a RADIUS user, a DHCP reservation and a DNS record.

8. Move the node to its rack port, which runs MAC auth, and power-cycle it. AMT then answers at `<addr>`, and Rufio drives later runs.
9. Comment `atlantis plan -d clusters/folly/talos`, then `atlantis apply`.
10. [Deploy spore](deploy-a-nixos-host.md) from `main`. spore then has a SPIRE alias for the node's LDevID.
11. Make sure that the node is Ready, that `talosctl --nodes <addr> get securitystate` shows `secureBoot: true`, and that its [SPIRE agent](add-a-tpm-node-to-spire.md#make-sure-the-agent-serves-svids) attests by LDevID.
12. If the merged export shows the node `staged`, export again in a pull request, and apply `clusters/folly/talos`.

## Watch the run

1. Watch the `Workflow`.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get workflows -w
   ```

   Result: `RUNNING` through `set-clock`, `attest`, `wipe-disk`, `install`, `next-boot` and `reboot`, then `SUCCESS`.

2. Watch the console and NetBox.

   Result: `attest: PASSED`, `attest_verdict` `attested`, and `install: installed Talos to <disk>`. The node boots the installed disk.

3. Watch NetBox.

   Result: the node fetches its config, and the controller sets `active`. A class that the controller does not render stays in HookOS.

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
| `install: no install code` | The attest step wrote no code, because attest withheld it | Read the `attest.install` audit line on the anchor, then set `desired_action` again |
| The node polls its config URL and gets 404 | A STATE wipe on an installed node, and a served code is spent | Set `desired_action` to `provision` for a new code |
| The audit line says 409 | The device lacks `talos_class`, or `class-inputs.json` lacks the class | Set the class, or run `mise run render-class-inputs` |

## Related

- [Prepare a machine](prepare-a-machine.md)
- [Reprovision a node](reprovision-a-node.md)
- [Retire a node](retire-a-node.md)
- [Hardware inventory](../reference/inventory.md)
