---
title: fleet-controller
description: A Go service on spore that turns NetBox's kubernetes-node devices into Tinkerbell's Hardware, Machine and Workflow objects, takes a new machine's intake and binds it to a node, starts a run when a device's desired_action is set, renders the Talos config an install fetches, and retires a decommissioning device.
status: unverified
---

fleet-controller makes [Tinkerbell](../platform/nixos/tinkerbell.md) follow NetBox. Git holds the `provision` Template and the BMC credential Secrets. The controller holds everything that names a machine: one `Hardware` per device, one Rufio `Machine` per device with a BMC, and a `Workflow` for each run the owner asks for in NetBox. Nothing about a machine is written in the repo, and no pull request starts a run.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| NetBox | The device's `desired_action` and `status` | The owner, in NetBox on capsule |
| Webhook | `http://<SPORE_IP>:8446/webhook` | NetBox's event rule, from the Anchor network, signed with the rule's secret |
| Intake | `http://<SPORE_IP>:8446/intake`, as `https://enroll.lolwtf.ca/fleet/intake` at the boot VIP | A new machine's HookOS, unauthenticated |
| Render | `http://<SPORE_IP>:8446/render` | [talos-attest](talos-attest.md) on any anchor, from the Anchor network, signed with `fleet-controller/attest-secret` |
| Install config | `https://enroll.lolwtf.ca/talos/config?uuid=<uuid>&code=<code>` | A node's first boot from disk, at the boot VIP |
| Health and metrics | `http://<SPORE_IP>:8446/healthz` and `/metrics` | The Anchor network |

To run a machine, set its `desired_action` in NetBox:

| `desired_action` | The run |
| --- | --- |
| `provision` | Attest, wipe the system disk, install Talos from HookOS and boot the disk; with installs off, or for a class the controller does not render, wipe the disk and leave the node in HookOS |
| `attest` | Attest, and boot the installed disk; nothing is wiped |
| `wipe` | Wipe the system disk and leave the node in HookOS; no attestation |

The controller creates `Workflow <action>-<name>-<unix seconds>`, sets `desired_action` back to `none`, writes the name to `last_workflow`, and adds a journal entry. `provision` and `wipe` move an `active` or `failed` device to `staged`; a `planned` device stays `planned`, because [talos-attest](talos-attest.md) grants a first intake its no-click pass only in that status and moves the device to `staged` itself on the verdict. `attest` leaves the status alone, so an active node stays active. To retire a machine, set its status to `decommissioning`: the controller runs `retire-<name>-<unix seconds>`, which wipes the disk and powers the node off, and when that run succeeds it deletes the machine's objects and sets the status to `offline`. [Provision a node](../runbooks/provision-a-node.md), [Reprovision a node](../runbooks/reprovision-a-node.md) and [Retire a node](../runbooks/retire-a-node.md) are the procedures.

## Limits

- A device needs a primary MAC on an interface and `install_disk` before it gets a `Hardware`, and a run waits for them with one journal entry.
- While an intake's `Hardware` holds a device's MAC, the device gets no `Hardware` of its own, since two with one MAC confuse Tinkerbell; the binding deletes the intake's objects. An intake whose device is neither `planned` nor `staged` is deleted once its run has stopped. A stub's `expected_port` never takes a switch port another cable holds, and a free address waits while UniFi does not answer. A binding the port check refuses keeps them until you move the machine or correct `expected_port`.
- One run at a time per device. While a run is unfinished, a new `desired_action` is recorded against the running `Workflow` and waits for it; the controller never starts a second run, which would power-cycle the node mid-wipe. The device's finished runs are deleted before a new one starts.
- A device with `tpm_version` `1.2`, or of class `worker-g2`, skips the attest step. A device with `bmc_type` `none` gets no `Machine`, and its `Workflow` waits for somebody to PXE-boot it by hand.
- A `planned` device boots by hand too, and its journal says so. It has no RADIUS user yet, so it and its AMT sit on the bootstrap fallback with a lease there, where Rufio cannot dial the Kubernetes address NetBox gives it. Its `Workflow` has no `bootMode`, and it gets a `Machine` only with an explicit `oob_ip`; the `Machine` arrives, and Rufio drives the next run, once the status leaves `planned`.
- A failed retirement is journaled once and the device stays `decommissioning`. The owner moves it on by hand. A device taken out of `decommissioning` before its retirement finished has that run deleted.
- The webhook is a "reconcile now" and nothing more. The event rule has no condition, so it rings on the controller's own writes too; those passes find nothing to do.
- `Workflow` objects older than 7 days are deleted. A device whose status leaves the exported set (`offline`, `inventory`, deleted) loses its `Hardware` and `Machine` on the next pass.
- `provision` and `wipe` erase every partition of the system disk, `META`, `STATE`, `EPHEMERAL`, `ETCD` and the `data` volume, as soon as Rufio reaches the BMC.

## Install

Installs are on: `nix/hosts/spore.nix` sets `homelab.fleetController.installs`. With the option off, no `Workflow` installs and `/render` refuses every call. A `provision` of a class whose class inputs say `worker` carries `install=true` and the class's `installer_image` in its `hardwareMap`, when the attest step runs. At the end of the intake talos-attest posts `{serial, uuid, node, class, code}` to `/render`, signed as HMAC-SHA512 hex of the body in `X-Fleet-Signature`. The controller answers 409 unless the device is `planned` or `staged`, its `last_workflow` is an unfinished `provision` run with `install=true`, its `smbios_uuid` is unset or the request's, and the code is unspent. It renders the config from the class inputs as [Talos enrollment](talos-enroll.md) does, writes `talos/<uuid>/<code>.yaml` under `/var/lib/fleet-controller`, and answers 201. The `install` action runs the installer with the code in META, and the node's first boot fetches the file by it.

nginx serves `/talos/config` on spore, and capsule and forge pass it to spore's Anchor address on port 8447 (`nix/lib/talos-config.nix`). Both Anchor-network legs, the render call and the proxied fetch, are plain HTTP. The controller reads nginx's log of the location every two seconds. A whole GET of the file's bytes deletes it and sets the device `active` with `attest_consumed_at`; a range, a HEAD or an aborted fetch deletes nothing. A served, expired or replaced code stays spent for a day, so a replayed render call is refused. A 404 for a machine with a waiting file is journaled at most every ten minutes. A file nobody fetched is deleted after two hours. Each step is an audit line, `fleet.render`, `fleet.release` or `fleet.expire`.

## Intake

Before HookOS's agent waits for work, it posts the machine's MAC, serial, UUID, model and disks to `/intake`. A malformed body is 400. One MAC may intake every ten minutes and twenty machines an hour; more is 429. A MAC on a NetBox interface or a `Hardware` answers 200 `known` and creates nothing. Otherwise the controller creates `Hardware <mac>`, labelled `lolwtf.ca/intake=true`, on the first NVMe disk, else the first disk that is no USB stick. It then creates `Workflow intake-<mac>-<unix seconds>`, a `provision` run with only `attest`, which boots nothing since the agent is connected, and answers 201. It never creates a NetBox device; talos-attest does, on a pass. An intake whose MAC no device holds is deleted after 24 hours.

When the intake run has finished and its device is `staged` and `attested`, a pass binds it. A device named `intake-<serial>` takes the stub with its serial, else the oldest serial-less stub of its model's class, and the stub's name; the stub is deleted. A device that talos-attest made of a stub keeps its name and gets its MAC from the intake if NetBox lacks one. `homelab.fleetController.modelMap` gives the class, BMC and install disk; an unknown model gets neither a class nor an install disk, since the intake's disks are a claim. The address is the stub's reserved one, else the lowest free one of `K8S_NODE_CIDR` that is neither the gateway, the API server nor a UniFi client's. UniFi's client list gives the switch port. On the provisioning station's port, `homelab.fleetController.intakePort`, no port check applies and only a stub's `expected_port` is cabled; elsewhere, a stub's `expected_port` must match, or nothing binds and the journal says why. A class and an address set `desired_action` to `provision`, whose run waits in HookOS without Rufio. Later passes cable a node with no cable to the rack port UniFi reports. Each step is journaled, with the audit lines `fleet.intake`, `fleet.bind` and `fleet.autoprovision`.

A stub's address is an IP address with the status `reserved`, the stub's name as its DNS name, and no interface, since a stub has no MAC; the binding assigns it and makes it the primary IPv4.

## How it works

Every two minutes, and two seconds after the webhook rings, the controller lists the site's devices with the role `kubernetes-node` and the status `planned`, `staged`, `active`, `failed` or `decommissioning`, with each device's first physical interface that has a primary MAC. It server-side-applies a `Hardware` whose iPXE script chains the signed HookOS UKI with the command line the UKI bakes in, and a `Machine` at the device's `oob_ip`, or its own address for AMT, with the Secret `bmc-<bmc_type>`. The `Hardware`'s `allowPXE` and `allowWorkflow` are true while the device has an unfinished `Workflow` and false otherwise: the controller turns them on before it creates a run, its `Workflow`s leave Tinkerbell's `toggleAllowNetboot` off, and each pass overwrites a value set by hand. The `Workflow` carries `wipe`, `attest`, `retire`, `install`, `installer_image`, `attest_url` and `ntp_server` in its `hardwareMap`, which the Template's actions read. Each decision is one JSON audit line on stdout with `event` `fleet.workflow` or `fleet.retire`. [talos-attest](talos-attest.md) does the attestation inside the run. The controller releases an installed worker's config.

## Operate

| Signal | Meaning |
| --- | --- |
| `/healthz` answers 503 | No pass succeeded within three intervals; `journalctl -u fleet-controller` on spore names the error |
| `fleet_reconcile_errors_total` rises | A pass ended with an error; the pass still did what it could |
| A device's journal says a run waits | The device lacks a MAC or `install_disk` in NetBox |
| `fleet_install_files_oldest_age_seconds` rises | A rendered config waits for its node's first boot; the install or the boot failed |
| `fleet_install_unreleased` is above 0 | nginx served a config and NetBox refused the release; the device's journal says why, and the controller retries |
| `fleet_install_renders_refused_total` rises | talos-attest asked for a render the device's state forbids; the controller's journal names the gate |
| `fleet_intake_limited_total` rises | Machines intake faster than the rate limits allow; a flood of claims, or many boxes at once |

## Reference

- Source and environment: `apps/fleet-controller/`
- spore: `nix/services/fleet-controller.nix`
- Template and Secrets: `clusters/folly/tinkerbell/`
- Image: `ghcr.io/jonpulsifer/fleet-controller`, for a boot plane that runs as containers
