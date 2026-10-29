---
title: fleet-controller
description: A Go service on spore that turns NetBox's kubernetes-node devices into Tinkerbell's Hardware, Machine and Workflow objects, starts a run when a device's desired_action is set, and retires a decommissioning device.
status: unverified
---

fleet-controller makes [Tinkerbell](../platform/nixos/tinkerbell.md) follow NetBox. Git holds the `provision` Template and the BMC credential Secrets. The controller holds everything that names a machine: one `Hardware` per device, one Rufio `Machine` per device with a BMC, and a `Workflow` for each run the owner asks for in NetBox. Nothing about a machine is written in the repo, and no pull request starts a run. No device has gone through it yet.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| NetBox | The device's `desired_action` and `status` | The owner, in NetBox on capsule |
| Webhook | `http://<SPORE_IP>:8446/webhook` | NetBox's event rule, from the Anchor network, signed with the rule's secret |
| Health and metrics | `http://<SPORE_IP>:8446/healthz` and `/metrics` | The Anchor network |

To run a machine, set its `desired_action` in NetBox:

| `desired_action` | The run |
| --- | --- |
| `provision` | Attest, wipe the system disk, and netboot the signed Talos UKI, which enrolls |
| `attest` | Attest, and boot the installed disk; nothing is wiped |
| `wipe` | Wipe the system disk and netboot; no attestation |

The controller creates `Workflow <action>-<name>-<unix seconds>`, sets `desired_action` back to `none`, writes the name to `last_workflow`, and adds a journal entry. `provision` and `wipe` move an `active` or `failed` device to `staged`; a `planned` device stays `planned`, because [talos-attest](talos-attest.md) grants a first intake its no-click pass only in that status and moves the device to `staged` itself on the verdict. `attest` leaves the status alone, so an active node stays active. To retire a machine, set its status to `decommissioning`: the controller runs `retire-<name>-<unix seconds>`, which wipes the disk and powers the node off, and when that run succeeds it deletes the machine's objects and sets the status to `offline`.

## Limits

- A device needs a primary MAC on an interface and `install_disk` before it gets a `Hardware`, and a run waits for them with one journal entry.
- One run at a time per device. While a run is unfinished, a new `desired_action` is recorded against the running `Workflow` and waits for it; the controller never starts a second run, which would power-cycle the node mid-wipe. The device's finished runs are deleted before a new one starts.
- A device with `tpm_version` `1.2`, or of class `worker-g2`, skips the attest step. A device with `bmc_type` `none` gets no `Machine`, and its `Workflow` waits for somebody to PXE-boot it by hand.
- A failed retirement is journaled once and the device stays `decommissioning`. The owner moves it on by hand. A device taken out of `decommissioning` before its retirement finished has that run deleted.
- The webhook is a "reconcile now" and nothing more. The event rule has no condition, so it rings on the controller's own writes too; those passes find nothing to do.
- `Workflow` objects older than 7 days are deleted. A device whose status leaves the exported set (`offline`, `inventory`, deleted) loses its `Hardware` and `Machine` on the next pass.
- `provision` and `wipe` erase every partition of the system disk, `META`, `STATE`, `EPHEMERAL`, `ETCD` and the `data` volume, as soon as Rufio reaches the BMC.

## How it works

Every two minutes, and two seconds after the webhook rings, the controller lists the site's devices with the role `kubernetes-node` and the status `planned`, `staged`, `active`, `failed` or `decommissioning`, with each device's first physical interface that has a primary MAC. It server-side-applies a `Hardware` whose iPXE script chains the signed HookOS UKI with the command line the UKI bakes in, and a `Machine` at the device's `oob_ip`, or its own address for AMT, with the Secret `bmc-<bmc_type>`. The `Workflow` carries `wipe`, `attest`, `retire`, `attest_url` and `ntp_server` in its `hardwareMap`, which the Template's actions read. Each decision is one JSON audit line on stdout with `event` `fleet.workflow` or `fleet.retire`. [talos-attest](talos-attest.md) does the attestation inside the run and [Talos enrollment](talos-enroll.md) releases the config after it.

## Operate

| Signal | Meaning |
| --- | --- |
| `/healthz` answers 503 | No pass succeeded within three intervals; `journalctl -u fleet-controller` on spore names the error |
| `fleet_reconcile_errors_total` rises | A pass ended with an error; the pass still did what it could |
| A device's journal says a run waits | The device lacks a MAC or `install_disk` in NetBox |

## Reference

- Source and environment: `apps/fleet-controller/`
- spore: `nix/services/fleet-controller.nix`
- Template and Secrets: `clusters/folly/tinkerbell/`
- Image: `ghcr.io/jonpulsifer/fleet-controller`, for a boot plane that runs as containers
