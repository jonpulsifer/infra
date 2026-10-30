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
- You are a tailnet login in `ATTEST_APPROVERS`, and you can read the console.
- `<node>` is the host name and `<serial>` the SMBIOS serial. An `<addr>` is a free address in `K8S_NODE_CIDR` of `clusters/folly/config/cluster-topology.json`.

## Declare the node

1. On a branch, add an entry under `nodes` in `clusters/folly/inventory/nodes.yaml` with `<node>`, its model, `<serial>`, its class, its switch port, `<addr>` and its BMC type. Add the model under `models` if it is new. [Hardware inventory](../reference/inventory.md#nodes-file) defines each key.
2. Open a pull request and comment `atlantis plan -d terraform/netbox/folly`, then `atlantis plan -d terraform/network/unifi/folly`.

   Result: the plans create the device, its address and its cable, the node's DNS record, and its switch port's name. They fail on an unknown model or class, or an address, port or serial another node holds.

3. Comment `atlantis apply`.

   Result: a `planned` device with the serial, class, address and a cable to the switch port, and no MAC.

## Plug a machine in

1. [Declare the node](#declare-the-node), with the machine's serial in its entry.
2. Connect the machine to its node port and power it on. Every node port carries the Kubernetes network: each declared node's `switch_port`, and `free_node_ports` in `terraform/network/unifi/folly/bootstrap.tf`. The machine stays on this port.

   Result: HookOS boots, and the console shows `attest: PASSED`. The device holds the machine's MAC, its `attested_*` fields and `attest_verdict` `attested`. If it waits instead, [approve the first intake](#approve-a-first-intake).

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

   Result: `attest: PASSED`, `install code written`, `install: installed Talos to <disk>`, and at the node's first boot, `active`.

## Approve a first intake

A serial no declared device names waits for approval, and the console shows `attest: FAILED` with `pending-approval`. So does a declared device whose EK has no manufacturer certificate.

> [!CAUTION]
> A waiting claim proves nothing, because another machine can send one with this serial. Approve only hashes that you read on the console.

1. Read the EK hashes, `rsa:<hash>` and `ecc:<hash>`, on the console.
2. Run `mise run attest:approve <serial>`, and answer `y` if the hashes match.
3. Power-cycle the machine, so that HookOS attests again.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The journal says `on port N, expected M` | A switch port the device does not expect | Move the machine, or correct `switch_port` in the nodes file, and power-cycle it |
| The `Workflow`'s Rufio job fails to power the machine | AMT does not answer at the node's address | Set AMT's address, or power the machine on by hand |
| The journal says the device `lacks` a field | `terraform/netbox/folly` has not applied the node's entry | Comment `atlantis plan -d terraform/netbox/folly` and apply it |
| The console says `attest: try 5 failed` | fleetd did not answer | Read `journalctl -u fleetd` on spore |
| The console says `attest: FAILED` and the agent starts at once | fleetd refused the machine | Read the `attest.verdict` audit line in `journalctl -u fleetd` |
| `desired_action` stays set | fleetd is down, or the device lacks a MAC or `install_disk` | Read the device's journal |
| The journal says `recorded no attested switch port` or `attested no switch port` | The switch sent no LLDP frame within 35 seconds of the attestation | Check that the switch sends LLDP, then power-cycle the machine |
| `wipe: this boot did not pass attestation` or `no install code` | The boot's attestation got no pass or no code, so nothing was wiped | Read the `attest.install` audit line in `journalctl -u fleetd`, then set `desired_action` again |
| The audit line says `no provision` | A last run the owner has not repeated, a control plane, or auto-provision is off | Set `desired_action` to `provision` |
| `EnrollmentNameNotServed` fires | fleetd is down, or its certificate lapsed | Read `journalctl -u fleetd` and the ACME units on spore |

## Related

- [Prepare a machine](prepare-a-machine.md)
- [Reprovision a node](reprovision-a-node.md)
- [Retire a node](retire-a-node.md)
