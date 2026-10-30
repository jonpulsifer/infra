---
title: Provision a node
description: Plug a prepared folly machine into any node port and let it intake, attest and install as a Talos worker or a joining control plane, or declare it in NetBox by hand.
---

Use this runbook to install a new folly node through [NetBox](../platform/netbox.md). The machine phones home from HookOS, [talos-attest](../apps/talos-attest.md) attests it, and [fleet-controller](../apps/fleet-controller.md) names, addresses and provisions it.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because NetBox holds each machine's lifecycle.

## Before you start

- A new machine is ready, as [Prepare a machine](prepare-a-machine.md) describes.
- You can sign in to NetBox at `https://capsule.<tailnet>`.
- You are a tailnet login in `ATTEST_APPROVERS`, and you can read the console.
- `<node>` is the host name and `<serial>` the SMBIOS serial. An `<addr>` is a free address in `K8S_NODE_CIDR` of `clusters/folly/config/cluster-topology.json`.

## Plug a machine in

1. Declare what you expect:

   ```sh
   mise run netbox:declare --stub <node> --class worker-g5 --serial <serial> [--port <rack port>] [--address <addr>]
   ```

   Result: a `planned` device with no MAC, a stub. The export skips stubs, so no pull request follows. With `--port`, the binding refuses a machine whose intake pass attests another switch port.

2. `--serial` is optional: a class-only stub names the next machine whose first intake you approve in step 4.
3. Connect the machine to a node port and power it on. Every node port carries the Kubernetes network: each inventory node's `switch_port`, and `free_node_ports` in `terraform/network/unifi/folly/bootstrap.tf`. The machine stays on this port.

   Result: the controller creates `Hardware <mac>`, with the address and LLDP port the machine claimed in its `lolwtf.ca/intake-address` and `lolwtf.ca/lldp-port-id` annotations, and an attest-only `Workflow intake-<mac>-<unix seconds>`. The pass writes the attested ones to the device's `attested_address` and `attested_switch_port`.

4. [Watch the run](#watch-the-run), and [approve the first intake](#approve-a-first-intake) if it waits.

   Result: the stub, or a new `intake-<serial>` device, is `planned` and `attested`.

5. Watch the device's NetBox journal.

   Result: `bound the intake`, with its name, class and address, and `desired_action` `provision`. HookOS takes the run, and the installed Talos boots with that address set statically.

6. Set the machine's AMT to the node's address, as [Prepare a machine](prepare-a-machine.md#set-amts-address) says, so Rufio reaches it for every later run.
7. On a branch, run `mise run netbox:export`. The export's `address` is the node's address everywhere.
8. Make sure that `mise run netbox:check` prints nothing. Open a pull request.
9. Comment `atlantis apply -d terraform/network/unifi/folly`.

   Result: the node has a DNS record, and its switch port carries its name.

10. Comment `atlantis plan -d clusters/folly/talos`, then `atlantis apply`.
11. [Deploy spore](deploy-a-nixos-host.md) from `main`, for the SPIRE alias.
12. Make sure that the node is Ready, that `talosctl --nodes <addr> get securitystate` shows `secureBoot: true`, and that its [SPIRE agent](add-a-tpm-node-to-spire.md#make-sure-the-agent-serves-svids) attests by LDevID.
13. If the merged export shows the node `planned`, export again in a pull request once NetBox holds it `active`, and apply `clusters/folly/talos`.

## Declare a machine by hand

Use this instead to name every fact yourself, from the HP label and the rack:

```sh
mise run netbox:declare <node> <serial> <mac> <switch port> <addr>
```

It refuses a malformed name or MAC, a missing port, and an address outside `K8S_NODE_CIDR`, or held by another device or stub. The `planned` device gets the MAC, a cable and `<addr>`; run it with no arguments for the options, whose defaults are the G5 mini's. Commit the export diff it prints in a pull request.

1. Connect the machine to `<switch port>`, and set its AMT to `<addr>`, as [Prepare a machine](prepare-a-machine.md#set-amts-address) says.
2. In NetBox, set `desired_action` to `provision`.

   Result: `last_workflow` names `provision-<node>-<unix seconds>`, the status stays `planned`, and Rufio powers the machine on through AMT at `<addr>` to a PXE boot. A device with no BMC journals `power the machine on by hand`.

3. [Watch the run](#watch-the-run), then continue from step 7 above.

## Provision a control plane

A control plane installs the same way and joins the running cluster. The cluster's first control plane, at `API_SERVER_IP`, never installs this way, because the Talos root bootstraps etcd on it.

1. Make sure that `nix/hosts/spore.nix` sets `homelab.fleetController.controlPlanes = true` and that spore runs it from `main`. Otherwise the run wipes the disk and installs nothing. [fleet-controller](../apps/fleet-controller.md#control-planes) says what spore then holds.
2. Declare the stub with `--class controlplane`, or declare the machine by hand with `--class controlplane`. `homelab.fleetController.modelMap` gives a G5 the class `worker-g5`, so only a declared class makes a control plane.
3. Follow [Plug a machine in](#plug-a-machine-in) or [Declare a machine by hand](#declare-a-machine-by-hand) to the end. A bound control plane is never auto-provisioned: at step 5 the journal says `no auto-provision: a control plane`, and you set `desired_action` to `provision` in NetBox yourself. In the export's pull request that shows the node `active`, also run `mise run render-class-inputs` and commit the result: the API server's SANs now name the node. The spore deploy at step 11 gives the controller the new class inputs for the next control plane.
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

   Result: `attest: PASSED`, `install: installed Talos to <disk>`, and at the node's first boot, `active`.

## Approve a first intake

With no pin, the console shows `attest: FAILED` with `pending-approval`.

> [!CAUTION]
> A waiting claim proves nothing, because another machine can send one with this serial. Approve only hashes that you read on the console.

1. Read the EK hashes, `rsa:<hash>` and `ecc:<hash>`, on the console.
2. Run `mise run attest:approve <serial>`, and answer `y` if the hashes match.
3. For an intake, delete its `Hardware <mac>`, or wait an hour, and power-cycle the machine. For a declared device, set `desired_action` to `provision` again.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The journal says `on port N, expected M` | A switch port the stub does not expect | Move the machine, or correct `expected_port` |
| The `Workflow`'s Rufio job fails to power the machine | AMT does not answer at the node's address | Set AMT's address, or power the machine on by hand |
| The journal says the model is not in `FLEET_MODEL_MAP` | An unknown model has no class | Set `talos_class` and `desired_action`, or extend `homelab.fleetController.modelMap` |
| No `Hardware <mac>` appears | The MAC is known, or the intake was refused | Read `fleet.intake` in `journalctl -u fleet-controller` on spore |
| `desired_action` stays set | The controller is down, or the device lacks a MAC or `install_disk` | Read the device's journal |
| The journal says `recorded no attested switch port` or `attested no switch port` | The switch sent no LLDP frame within 35 seconds of the attest action | Check that the switch sends LLDP, then run `attest` |
| The journal says a port `is cabled to another device in NetBox` | NetBox holds another device's cable on the attested port | Correct the cables in NetBox; the controller never removes one |
| `install: no install code` | Attest withheld the code | Read the `attest.install` audit line, then set `desired_action` again |
| The audit line says 409 | No `talos_class`, or `class-inputs.json` lacks it | Set the class, or run `mise run render-class-inputs` |

## Related

- [Prepare a machine](prepare-a-machine.md)
- [Reprovision a node](reprovision-a-node.md)
- [Retire a node](retire-a-node.md)
