---
title: fleetd lifecycle
description: How fleetd schedules installation, disk actions and retirement.
---

fleetd reads owner requests from NetBox and runs one Tinkerbell Workflow per device at a time.

## Requests

| `desired_action` | The run |
| --- | --- |
| `provision` | Boot HookOS, attest, wipe the system disk, install Talos and boot the disk. A class without a renderer stays in HookOS after the wipe. |
| `attest` | Boot HookOS, attest and boot the disk again. |
| `wipe` | Wipe the system disk and stay in HookOS. |

The `decommissioning` status requests retirement separately from `desired_action`.

## Class policy

Git owns the class table at `clusters/folly/fleet/classes.json`. fleetd reads it through `FLEET_CLASSES`.

Each class declares its operating system, Workflow template, installer image, boot-policy profile, Secure Boot requirement, payload kind and reattestation behavior. Talos installer images come from `class-inputs.json`; other installer images use a digest.

An unknown class is refused and journaled. The verifier also refuses a missing profile or a Secure Boot mismatch.

The `talos` profile applies to Talos classes. The `ubuntu` profile accepts Microsoft's UEFI CA 2011 and 2023 and Canonical's Master CA after the PCR 7 separator. It pins no shim or GRUB digest.

fleetd records SHA-256 hashes of dbx and shim's `SbatLevel` in `dbx_hash` and `sbat_level`. A change produces a journal warning, without quarantine.

## Disk protection

Provision, wipe and retirement require `install_disk_serial`. Without it, the request stays pending and fleetd records the reason.

The Workflow carries the serial in `hardwareMap`. Before a write, the template requires all three conditions:

- The disk at the declared kernel name reports that serial.
- No other disk reports the same serial.
- The disk is neither removable nor attached through USB.

## Retirement

1. The retirement Workflow wipes and erases the disk, then powers off the machine.
2. fleetd cordons the Kubernetes node and evicts its pods. It waits up to ten minutes for a PodDisruptionBudget.
3. fleetd deletes the Node, kubelet certificate requests and bootstrap token.
4. fleetd sets the device to `offline`.

If the Kubernetes API is unavailable, the device stays `decommissioning`. fleetd journals the fault once and retries each pass.

## Concurrent requests

Tinkerbell can deliver actions from multiple Workflows in a random order. fleetd therefore allows only one unfinished Workflow per device.

A request for the current action is consumed. A different action stays pending until the current run ends. fleetd journals the wait once.

If NetBox rejects a new run's record, fleetd adopts the existing Workflow, whether running or finished, and retries the write. It never creates a duplicate run. The journal says `its record was late`.

If retirement interrupts another run, fleetd first requests power-off through the baseboard management controller (BMC), using a Rufio Job. After power-off, it rechecks the run before deleting it and starting retirement.

Without a BMC, or if power-off fails, retirement waits. Deleting a Workflow alone does not stop its executing action.

If retirement fails at the BMC Job, no disk action runs. fleetd journals the Job and BMC response. Retry delays double from five minutes to four hours while the device stays `decommissioning`.

## Configuration access

Only a `planned` device can fetch its configuration. Leaving that state or disappearing from NetBox removes its unread configuration. A NetBox outage returns HTTP 503 so the node can retry.

## Related

- [fleetd overview](../fleetd.md)
- [Provision a node](../../runbooks/provision-a-node.md)
- [Reprovision a node](../../runbooks/reprovision-a-node.md)
- [Retire a node](../../runbooks/retire-a-node.md)
- Workflow rules: "One run per machine" in `apps/fleetd/README.md`
