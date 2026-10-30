---
title: Provision a node
description: Plug a prepared folly machine in at the provisioning station and let it intake, attest and install as a Talos worker or a joining control plane, or declare it in NetBox by hand.
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

   Result: a `planned` device with no MAC, a stub. The export skips stubs, so no pull request follows.

2. If talos-attest admits serials no stub names, `--serial` is optional: a class-only stub names the next machine. Open its window if needed: `mise run fleet:intake open 2h`.
3. Connect the machine to the prep station's port, `provisioning` in `quarantine_ports` of `terraform/network/unifi/folly/bootstrap.tf`, and power it on. It stays there until step 9. On this port the installed Talos boots and fetches its config, then stalls with DNS i/o timeouts, because its resolvers are on the Anchor network, which the bootstrap VLAN cannot reach. The move to the rack port is the fix, and the node joins after it.

   Result: the controller creates `Hardware <mac>` and an attest-only `Workflow intake-<mac>-<unix seconds>`.

4. [Watch the run](#watch-the-run), and [approve the first intake](#approve-a-first-intake) if it waits.

   Result: the stub, or a new `intake-<serial>` device, is `staged` and `attested`.

5. Watch the device's NetBox journal.

   Result: `bound the intake`, with its name, class and address, and `desired_action` `provision`. HookOS takes the run.

6. On a branch, run `mise run netbox:export`. The export's `address` is the node's address everywhere.
7. Make sure that `mise run netbox:check` prints nothing. Open a pull request.
8. Comment `atlantis apply -d terraform/network/unifi/folly`.

   Result: the node has a RADIUS user, a DHCP reservation and a DNS record.

9. Move the node to its rack port, which runs MAC auth, and power-cycle it. Without `--port`, the controller cables it from UniFi.
10. Comment `atlantis plan -d clusters/folly/talos`, then `atlantis apply`.
11. [Deploy spore](deploy-a-nixos-host.md) from `main`, for the SPIRE alias.
12. Make sure that the node is Ready, that `talosctl --nodes <addr> get securitystate` shows `secureBoot: true`, and that its [SPIRE agent](add-a-tpm-node-to-spire.md#make-sure-the-agent-serves-svids) attests by LDevID.
13. If the merged export shows the node `staged`, export again in a pull request, and apply `clusters/folly/talos`.

## Declare a machine by hand

Use this instead to name every fact yourself, from the HP label and the rack:

```sh
mise run netbox:declare <node> <serial> <mac> <switch port> <addr>
```

It refuses a malformed name or MAC, a missing port, and an address outside `K8S_NODE_CIDR`, or held by another device or stub. The `planned` device gets the MAC, a cable and `<addr>`; run it with no arguments for the options, whose defaults are the G5 mini's. Commit the export diff it prints in a pull request.

1. Connect the machine to the prep station's port.
2. In NetBox, set `desired_action` to `provision`.

   Result: `last_workflow` names `provision-<node>-<unix seconds>`, and the status stays `planned`.

3. Power on the machine by hand.
4. [Watch the run](#watch-the-run), then continue from step 6 above.

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
| The journal says `on port N, expected M` | A rack port the stub does not expect | Move the machine, or correct `expected_port` |
| The journal says the model is not in `FLEET_MODEL_MAP` | An unknown model has no class | Set `talos_class` and `desired_action`, or extend `homelab.fleetController.modelMap` |
| No `Hardware <mac>` appears | The MAC is known, or the intake was refused | Read `fleet.intake` in `journalctl -u fleet-controller` on spore |
| `desired_action` stays set | The controller is down, or the device lacks a MAC or `install_disk` | Read the device's journal |
| `install: no install code` | Attest withheld the code | Read the `attest.install` audit line, then set `desired_action` again |
| The audit line says 409 | No `talos_class`, or `class-inputs.json` lacks it | Set the class, or run `mise run render-class-inputs` |

## Related

- [Prepare a machine](prepare-a-machine.md)
- [Reprovision a node](reprovision-a-node.md)
- [Retire a node](retire-a-node.md)
