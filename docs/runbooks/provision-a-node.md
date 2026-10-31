---
title: Provision a node
description: Declare a folly machine in the nodes file, plug it into its node port, and let it attest and install as a Talos worker or a joining control plane.
---

Use this runbook to install a new folly node. Its entry in the nodes file becomes a [NetBox](../platform/netbox.md) device, the machine attests from HookOS on every boot, and [fleetd](../apps/fleetd.md) admits the device its serial names and provisions it.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because NetBox holds each machine's lifecycle.

## Before you start

- A new machine is ready, as [Prepare a machine](prepare-a-machine.md) describes.
- You can sign in to NetBox at `https://capsule.<tailnet>`.
- You hold independent evidence of the machine's EKs: a receiving scan of its TPM, or the supplier's authenticated record that ties its chassis serial to its EK hashes. [Approve a machine's EKs](#approve-a-machines-eks) says what counts.
- You have the serial of the machine's install disk, from the disk's label or a receiving scan.
- You are a tailnet login in `ATTEST_APPROVERS`, and you can read the console.
- `<node>` is the host name and `<serial>` the SMBIOS serial. An `<addr>` is a free address in `K8S_NODE_CIDR` of `clusters/folly/config/cluster-topology.json`.

## Declare the node

1. On a branch, add an entry under `nodes` in `clusters/folly/inventory/nodes.yaml` with `<node>`, its model, `<serial>`, its class, its switch port, `<addr>`, its BMC type, its install disk's serial as `disk_serial`, and its approved EK binding from your evidence, `approved_ek_rsa2048` and `approved_ek_eccp256`. Add the model under `models` if it is new. [Hardware inventory](../reference/inventory.md#nodes-file) defines each key.
2. Open a pull request and comment `atlantis plan -d terraform/netbox/folly`, then `atlantis plan -d terraform/network/unifi/folly`.

   Result: the plans create the device, its address and its cable, the node's DNS record, and its switch port's name. They fail on an unknown model or class, an address, port, serial, disk serial or approved EK another node holds, or an approved EK hash that is not 64 lowercase hex characters.

3. Comment `atlantis apply`.

   Result: a `planned` device with the serial, class, address, `install_disk_serial`, `approved_ek_hash` and `approved_ek_hash_ecc`, and a cable to the switch port, and no MAC.

## Plug a machine in

1. [Declare the node](#declare-the-node), with the machine's serial in its entry.
2. Connect the machine to its node port and power it on. Every node port carries the Kubernetes network: each declared node's `switch_port`, and `free_node_ports` in `terraform/network/unifi/folly/bootstrap.tf`. The machine stays on this port.

   Result: HookOS boots, and the console shows `attest: PASSED`. The device holds the machine's MAC, its `attested_*` fields and `attest_verdict` `attested`. If it shows `pending-approval` instead, the entry approves no EK; [approve its EKs](#approve-a-machines-eks).

3. Watch the device's NetBox journal, and [the run](#watch-the-run).

   Result: `started Workflow provision-<node>-<unix seconds>`, with the note that the machine attested from HookOS. HookOS takes the run, and the installed Talos boots with its address set statically.

4. Set the machine's AMT to the node's address, as [Prepare a machine](prepare-a-machine.md#set-amts-address) says, so Rufio reaches it for every later run.
5. Once NetBox holds the node `active`, open a pull request, comment `atlantis plan -d clusters/folly/talos`, then `atlantis apply`.

   Result: the Talos root manages the node, since it reads each node's status from NetBox.

6. [Deploy spore](deploy-a-nixos-host.md) from `main`, for the SPIRE alias.
7. Make sure that the node is Ready, that `talosctl --nodes <addr> get securitystate` shows `secureBoot: true`, and that its [SPIRE agent](add-a-tpm-node-to-spire.md#make-sure-the-agent-serves-svids) attests by LDevID.

## Provision a control plane

A control plane installs the same way and joins the running cluster. The cluster's first control plane, at `API_SERVER_IP`, never installs this way, because the Talos root bootstraps etcd on it.

1. Make sure that `nix/hosts/spore.nix` sets `homelab.fleetd.controlPlanes = true` and that spore runs it from `main`. Otherwise the run wipes the disk and installs nothing, and spore holds no bundle with the cluster's CA keys.
2. [Declare the node](#declare-the-node) with the class `controlplane`.
3. Follow [Plug a machine in](#plug-a-machine-in). An admitted control plane is never auto-provisioned: its attestation passes and the machine waits in HookOS. Set `desired_action` to `provision` in NetBox; fleetd starts the run, and Rufio power-cycles the machine so that its next attestation takes the code. In the pull request of step 5, also run `mise run render-class-inputs` and commit the result: the API server's SANs now name the node. The spore deploy at step 6 gives fleetd the new class inputs for the next control plane.
4. After the `clusters/folly/talos` apply, make sure that the node is an etcd member:

   ```sh
   talosctl --nodes <addr> etcd members
   ```

   Result: every control plane is listed, and none is a learner.

> [!WARNING]
> The Talos root upgrades every control plane in `talos_machine.joining` in parallel, beside the workers. With two joining control planes, one Talos upgrade can take two of three etcd members down at once and lose quorum. Before a second joining control plane exists, serialise their upgrades, for example with `-parallelism=1` on the `clusters/folly/talos` apply, or with one resource per joining control plane.

## Watch the run

1. Watch the `Workflow`.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get workflows -w
   ```

   Result: `SUCCESS`.

2. Watch the console and NetBox.

   Result: `attest: PASSED`, `install code written`, `wipe: <disk> reports the serial <disk serial>`, `install: installed Talos to <disk>`, and at the node's first boot, `active`.

## Approve a machine's EKs

fleetd admits a `planned` device only when its TPM proves every EK that the node's entry approves. A device with no binding waits, and the console shows `attest: FAILED` with `pending-approval`, even when a trusted maker certified each EK. So does a serial no entry names.

The trust source is the receiving step. Accept a receiving scan of the machine's TPM, or a supplier's authenticated record that ties the chassis serial to its EK hashes. A platform certificate counts only when its validated contents tie the two. A serial that SMBIOS or Redfish reports does not.

> [!CAUTION]
> A waiting claim proves nothing, because another machine can send one with this serial. Compare it with your evidence; never approve it alone.

1. Print the lines for the waiting claim:

   ```bash
   mise run attest:approve <serial>
   ```

   Result: the claim, then `approved_ek_rsa2048: <hash>` and `approved_ek_eccp256: <hash>` for the node's entry. The task approves nothing.

2. Compare each hash with your evidence. If one differs, stop: another TPM claims the serial.
3. On a branch, add the lines to the node's entry, open a pull request, and comment `atlantis plan -d terraform/netbox/folly`, then `atlantis apply`.

   Result: the device's `approved_ek_hash` and `approved_ek_hash_ecc` hold the hashes.

4. Power-cycle the machine, so that HookOS attests again.

   Result: `attest: PASSED`.

A replaced TPM, as after a board swap, needs the same change: the old binding refuses the new TPM until the entry names its EKs.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The journal says `on port N, expected M` | A switch port the device does not expect | Move the machine, or correct `switch_port` in the nodes file, and power-cycle it |
| The `Workflow`'s Rufio job fails to power the machine | AMT does not answer at the node's address | Set AMT's address, or power the machine on by hand |
| The journal says the device `lacks` a field | `terraform/netbox/folly` has not applied the node's entry | Comment `atlantis plan -d terraform/netbox/folly` and apply it |
| The console says `attest: try 5 failed` | fleetd did not answer | Read `journalctl -u fleetd` on spore |
| The console says `attest: FAILED` and the agent starts at once | fleetd refused the machine | Read the `attest.verdict` audit line in `journalctl -u fleetd` |
| `attest: FAILED` with `ek-hash-mismatch` or `ek-missing` | The TPM is not the one the entry approves | Read the refused EK hash in the `attest.verdict` audit line in `journalctl -u fleetd`, and compare it with your evidence. Nothing was written |
| `attest: FAILED` with `ek-binding-unauthored` | NetBox's changelog does not show Terraform's user writing the binding: another user edited it, the changelog lost the record, or `bindingAuthor` is unset on spore | Read the device's journal. Restore the binding from git: remove the lines, apply, add them back and apply, so that Terraform writes it again |
| `desired_action` stays set | fleetd is down, or the device lacks a MAC, `install_disk` or `install_disk_serial` | Read the device's journal. A journal that says the run waits for `install_disk_serial` needs `disk_serial` in the node's entry and an apply of `terraform/netbox/folly` |
| `wipe: no disk reports the serial`, or `<disk> is <name>, but the disk that reports <serial> is <other>` | The disk at `install_disk` is not the declared disk: the slots swapped, the disk is missing or replaced, or a USB disk took its name. Nothing was wiped or installed | Read the machine's disks. Fix the hardware, or correct `disk` or `disk_serial` in the nodes file and apply it, then set `desired_action` again |
| `wipe: <disk> is removable`, `is on USB`, or `more than one disk reports the serial` | The declared serial names a removable or USB disk, or two disks report it. Nothing was wiped | Remove the extra disk, or correct `disk_serial` |
| `wipe: no install disk serial is declared` | The Workflow carries no `install_disk_serial` | Make sure that spore runs fleetd from `main` and the device holds `install_disk_serial`, then set `desired_action` again |
| The journal says `recorded no attested switch port` or `attested no switch port` | The switch sent no LLDP frame within 35 seconds of the attestation | Check that the switch sends LLDP, then power-cycle the machine |
| `wipe: this boot did not pass attestation` or `no install code` | The boot's attestation got no pass or no code, so nothing was wiped | Read the `attest.install` audit line in `journalctl -u fleetd`, then set `desired_action` again |
| The journal says a Workflow `never reported its first action within its global timeout` | The run stops before wipe-disk reports: a power loss, a machine that never reaches HookOS, or an agent that dies. Tinkerbell sets such a run no deadline, so fleetd deletes the Workflow, and no later boot resumes it. The disk may be partly wiped or may still hold the old install | Set `desired_action` to `provision`. A device without a BMC that still waits in HookOS needs a power cycle by hand |
| `install: failed to perform disk operations: disk <install_disk> is not empty, skipping install`, then `install: the installer failed; the lines above are its last output`, and the run is `FAILED` | The run is interrupted after the installer starts writing, by a power loss or an agent restart, and the next boot gets the install action again. Nothing is wiped | Set `desired_action` to `provision`. The new run wipes the disk and installs |
| The journal says a Workflow `ended FAILED` or `ended TIMEOUT` and names an action | A provision or wipe ended without success. The Workflow's own message says only `action completed`; the reason is the action's output | Run `journalctl -u tinkerbell \| grep <address>` on spore, with the address the journal line gives, and read the action's last lines. Fix the cause, then set `desired_action` to `provision`. A retirement that ended this way is a `danger` line: the disk may not be wiped, so the node may still hold its data and its identity, and the device stays `decommissioning` |
| `install: docker: Error response from daemon:` with `manifest for ... not found: manifest unknown`, `connection refused` or `context deadline exceeded`, then `install: the installer failed; the lines above are its last output`, and the run is `FAILED` or `TIMEOUT` | The installer image could not be pulled after the wipe. The disk is blank and the machine waits in HookOS | Check that the registry answers and that the class's `installer_image` names an image it holds, then set `desired_action` to `provision` |
| The run is `FAILED` at `wipe-disk`, and the agent's log says `error executing action All attempts fail: #1: docker:` | The tools image could not be pulled, so no script ran and the disk is unchanged. The error is only in the agent's log | Check that the registry holds the tools image, then set `desired_action` to `provision` |
| The node is `active`, and the journal says its Workflow `passed its global timeout` while `install`, `next-boot` or `reboot` was current | The run's last reports are lost, as to a power loss after the install. The disk holds the whole install, and the node boots it under the run's code | Nothing: the node has its config |
| The node polls its config URL and gets 503 | fleetd serves a config only while NetBox shows the device `planned`, and NetBox does not answer | Make NetBox answer at `https://capsule.<tailnet>`. The node fetches its config on its next try, inside `FLEET_CONFIG_TTL` |
| After a power loss before its first config fetch, the node polls its config URL and gets 404 | The config waits unread for `FLEET_CONFIG_TTL` and then expires | Set `desired_action` to `provision`. Inside that window the node fetches its config on its own |
| `FleetInstallConfigMissing` fires, and the journal says `the node asked for its Talos config, and fleetd holds none for it` | spore rebooted after the render, which drops every config that waits, or the config passed its TTL. When the journal says `fleetd served the config of <run>`, fleetd served it, NetBox has not taken the release, and the node did not keep it. The run finished, so the node boots its install and asks in vain, and the device stays `planned` | Set `desired_action` to `provision`. The new run renders a new code and config. The alert clears 30 minutes after the node stops asking |
| `FleetInstallConfigRefetched` fires, and the journal says `the node asked again for the Talos config fleetd served it`. The device may be `active` with a `success` line for the fetch | The node's kernel acknowledged the whole config, and the node lost it before Talos wrote it to STATE, as to a power loss or a reset in that second. Its code is spent, and fleetd serves no config twice, so the node asks in vain | Set `desired_action` to `provision`. The new run wipes the disk and installs under a new code. The disk holds no STATE, so nothing is lost. The alert clears 30 minutes after the node stops asking |
| The journal says `the peer did not acknowledge all of it` | A fetch's answer did not reach the node whole before the connection closed or the write deadline passed, as when the network or the power fails mid-answer. The config stays | Nothing, unless the node is not fetching it: the node's next fetch gets it whole, inside `FLEET_CONFIG_TTL`. A peer that is not the node held the code; read the address in the line |
| `FleetNodeBootedHookOSAfterInstall` fires, and the journal says `the node booted HookOS and attested after Workflow` | The run succeeded, but the firmware netbooted again instead of the installed disk, as with PXE first in the boot order. The config stays unread | Fix the node's boot order so the disk comes before PXE, then set `desired_action` to `provision`. The journal line comes once per run |
| The audit line says `no provision` | A last run the owner has not repeated, a control plane, or auto-provision is off | Set `desired_action` to `provision` |
| `EnrollmentNameNotServed` fires | fleetd is down, or its certificate lapsed | Read `journalctl -u fleetd` and the ACME units on spore |

## Related

- [Prepare a machine](prepare-a-machine.md)
- [Reprovision a node](reprovision-a-node.md)
- [Retire a node](retire-a-node.md)
