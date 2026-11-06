---
title: fleetd lifecycle
description: How fleetd schedules installation, disk actions and retirement.
---

fleetd reads owner requests from NetBox and runs one Tinkerbell Workflow per device at a time, or under the boot executor one fleet-boot attempt.

## Requests

| `desired_action` | The run |
| --- | --- |
| `provision` | Boot HookOS, attest, wipe the system disk, install Talos and boot the disk. A class without a renderer stays in HookOS after the wipe. |
| `attest` | Boot HookOS, attest and boot the disk again. |
| `wipe` | Wipe the system disk and stay in HookOS. |

The `decommissioning` status requests retirement separately from `desired_action`.

## BMC mode

`homelab.fleetd.bmc` in `nix/services/fleetd.nix` sets `FLEET_BMC`, which says who drives each machine's baseboard management controller (BMC). The default is `rufio`; spore sets `native` in `nix/hosts/spore.nix`.

| Need | `rufio` | `native` |
| --- | --- | --- |
| Network-boot a run's machine | The Workflow carries `bootMode: netboot`, and Tinkerbell's controller runs the Rufio Job `netboot-<workflow>`: power off, one-time PXE, power on | fleetd does the same three steps through the BMC before it creates the Workflow, which carries no boot mode |
| Stop a run | The Rufio Job `stop-<run>` | fleetd asks the BMC for the power-off itself |
| Read the power state | The Rufio `Machine`'s `status.powerState` | fleetd reads the BMC |
| Credential | The Flux Secret `bmc-amt` in Tinkerbell's namespace | `fleetd/bmc-amt` in spore's sops file, a JSON object with `username` and `password`, through `FLEET_BMC_AMT_CREDENTIAL_FILE` |
| Per-run state | Annotations on the Workflow | `FLEET_BMC_STATE_FILE`, `/var/lib/fleetd/bmc-runs.json` |

In `native` mode fleetd makes no Rufio `Machine` or `Job`, deletes the `Machine`s it made before, and its `Hardware` names no `Machine`. `apps/fleetd/bmc` drives Intel AMT through bmclib's AMT provider, the same code Rufio runs, over plain HTTP digest auth on port 16992.

A native netboot sets the PXE boot only once the BMC reports the machine off. A machine still on after a pass's 30-second wait, such as one whose OS shuts down on a graceful soft off, keeps its request, and a later pass goes on with the same run; the netboot fails when the machine is still on 10 minutes after the power-off. A netboot that fails creates no Workflow, so no later boot of the machine runs it: fleetd records the run in `last_workflow`, clears `desired_action` and journals the BMC's answer, as a run that ended at its boot job in `rufio` mode.

## Class policy

Git owns the class table at `clusters/folly/fleet/classes.json`. fleetd reads it through `FLEET_CLASSES`.

Each class declares its operating system, workload, Workflow template, boot-policy profile, Secure Boot requirement, payload kind and reattestation behavior, and what its install writes: a Talos class pins its installer image by digest, and an image class (`nixos`, `debian`) pins a disk image by URL, digest and format (`image`, `image_digest`, `image_format`). `.github/workflows/talos-images.yml` writes the Talos classes' pin after each build, and fleetd prefers it over the tag `class-inputs.json` carries for the Talos root; `.github/workflows/node-images.yml` writes the `nixos` class's pin the same way; the `debian` pin is the dated generic release, the variant with drivers for physical hardware, set by hand from its `SHA512SUMS`. A class with no complete pin installs nothing. A Talos class may also pin its signed metal disk image the same way, which [fleet-boot](../../platform/nixos/fleet-boot.md#talos) writes in place of the installer; Tinkerbell's Template ignores it.

An unknown class is refused and journaled. The verifier also refuses a missing profile or a Secure Boot mismatch.

The `talos` profile applies to the Talos classes and to `nixos`, whose image boots a UKI signed by the same lab key. The `debian` profile accepts Microsoft's UEFI CA 2011 and 2023 and Debian's Secure Boot CA after the PCR 7 separator. It pins no shim or GRUB digest. The `ubuntu` profile, Canonical's CA in the same shape, stays on disk with no class.

fleetd records SHA-256 hashes of dbx and shim's `SbatLevel` in `dbx_hash` and `sbat_level`. A change produces a journal warning, without quarantine.

## Disk protection

Provision, wipe and retirement require `install_disk_serial`. Without it, the request stays pending and fleetd records the reason.

The Workflow carries the serial in `hardwareMap`. Before a write, the template requires all three conditions:

- The disk at the declared kernel name reports that serial.
- No other disk reports the same serial.
- The disk is neither removable nor attached through USB.

## Retirement

1. The retirement Workflow wipes and erases the disk, then powers off the machine.
2. fleetd acts on the Workflow's success only once the BMC reports the machine off, through the Rufio `Machine` or, in `native` mode, its own read of the BMC, since the agent's report alone is unauthenticated. It journals the wait once, and a `danger` line after 15 minutes. A device without a BMC proceeds on the agent's report, and the journal says so.
3. fleetd cordons the Kubernetes node and evicts its pods. It waits up to ten minutes for a PodDisruptionBudget.
4. fleetd deletes the Node, kubelet certificate requests and bootstrap token.
5. fleetd sets the device to `offline`.

If the Kubernetes API is unavailable, the device stays `decommissioning`. fleetd journals the fault once and retries each pass.

## Concurrent requests

Tinkerbell can deliver actions from multiple Workflows in a random order. fleetd therefore allows only one unfinished Workflow per device.

A request for the current action is consumed. A different action stays pending until the current run ends. fleetd journals the wait once.

If NetBox rejects a new run's record, fleetd adopts the existing Workflow, whether running or finished, and retries the write. It never creates a duplicate run. The journal says `its record was late`.

If retirement interrupts another run, fleetd first requests power-off through the BMC: a Rufio Job, or in `native` mode its own request. After power-off, it rechecks the run before deleting it and starting retirement.

Without a BMC, or if power-off fails, retirement waits. Deleting a Workflow alone does not stop its executing action.

If retirement fails at its netboot, no disk action runs. fleetd journals the BMC's response, with the Rufio Job's name in `rufio` mode. Retry delays double from five minutes to four hours while the device stays `decommissioning`.

## Executors

`homelab.fleetd.executor` on spore, `FLEET_EXECUTOR`, picks what runs a run. It is `tinkerbell` by default: HookOS runs the Workflow's Template. Under `boot`, [fleet-boot](../../platform/nixos/fleet-boot.md) runs the same steps, from its NixOS image or its Alpine one, and fleetd keeps the run as an attempt record in its state directory in place of a Workflow. The attempt takes the session of the machine's intake pass, and fleet-boot's requests over it are signed by that session's AK, so its reports never rest on a MAC. The rules on this page hold under both: one run per device, the overdue end, and a failure that waits for a new request.

`menu_default` in `clusters/folly/talos/netboot.json` must boot the same executor's image, `hookos` under `tinkerbell` and `fleetboot` or `alpine` under `boot`; the `fleet-boot-image` check fails otherwise. A device that cannot attest, such as a TPM 1.2 node, gets no session, so under `boot` its run never starts and ends as overdue.

## Configuration access

Only a `planned` device can fetch its configuration. Leaving that state, disappearing from NetBox, or the end of its Workflow without success removes its unread configuration. A NetBox outage returns HTTP 503 so the node can retry.

## Related

- [fleetd overview](../fleetd.md)
- [fleet-boot](../../platform/nixos/fleet-boot.md), the lab's own boot image, which attests as HookOS does
- [Provision a node](../../runbooks/provision-a-node.md)
- [Reprovision a node](../../runbooks/reprovision-a-node.md)
- [Retire a node](../../runbooks/retire-a-node.md)
- Workflow rules: "One run per machine" in `apps/fleetd/README.md`
