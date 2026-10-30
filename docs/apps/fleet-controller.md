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
| Intake | `http://<SPORE_IP>:8446/intake`, as `https://enroll.lolwtf.ca/fleet/intake` at the boot VIP | Every machine's HookOS, unauthenticated |
| Render | `http://<SPORE_IP>:8446/render` | [talos-attest](talos-attest.md) on any anchor, from the Anchor network, signed with `fleet-controller/attest-secret` |
| Install config | `https://enroll.lolwtf.ca/talos/config?uuid=<uuid>&code=<code>` | A node's first boot from disk, at the boot VIP |
| Health and metrics | `http://<SPORE_IP>:8446/healthz` and `/metrics`; spore's `fleet-controller-metrics` timer copies `/metrics` into node-exporter each minute | The Anchor network, and Prometheus through node-exporter |

To run a machine, set its `desired_action` in NetBox:

| `desired_action` | The run |
| --- | --- |
| `provision` | Attest, wipe the system disk, install Talos from HookOS and boot the disk; with installs off, or for a class the controller does not render, wipe the disk and leave the node in HookOS |
| `attest` | Attest, and boot the installed disk; nothing is wiped |
| `wipe` | Wipe the system disk and leave the node in HookOS; no attestation |

The controller creates `Workflow <action>-<name>-<unix seconds>`, sets `desired_action` back to `none`, writes the name to `last_workflow`, and adds a journal entry. `provision` and `wipe` move an `active` or `failed` device to `staged`; a `planned` device stays `planned`, because [talos-attest](talos-attest.md) grants a first intake its no-click pass only in that status and moves the device to `staged` itself on the verdict. `attest` leaves the status alone, so an active node stays active. To retire a machine, set its status to `decommissioning`: the controller runs `retire-<name>-<unix seconds>`, which wipes the disk and powers the node off, and when that run succeeds it deletes the machine's objects and sets the status to `offline`. [Provision a node](../runbooks/provision-a-node.md), [Reprovision a node](../runbooks/reprovision-a-node.md) and [Retire a node](../runbooks/retire-a-node.md) are the procedures.

## Limits

- A device needs a primary MAC on an interface and `install_disk` before it gets a `Hardware`, and a run waits for them with one journal entry.
- While an intake's `Hardware` holds a device's MAC, the device gets no `Hardware` of its own, since two with one MAC confuse Tinkerbell; the binding deletes the intake's objects. An intake whose device is neither `planned` nor `staged` is deleted once its run has stopped. No cable the controller makes takes a switch port another device's cable holds: the other cable stays, and the journal names the conflict. A binding the port check refuses keeps them until you move the machine or correct `expected_port`.
- One run at a time per device. While a run is unfinished, a new `desired_action` is recorded against the running `Workflow` and waits for it; the controller never starts a second run, which would power-cycle the node mid-wipe. The device's finished runs are deleted before a new one starts.
- A device with `tpm_version` `1.2`, or of class `worker-g2`, skips the attest step. A device with `bmc_type` `none` gets no `Machine`, and its `Workflow` waits for somebody to PXE-boot it by hand.
- A `planned` device has no RADIUS user yet, so it and its AMT sit on the bootstrap fallback with a lease there, where Rufio cannot dial the Kubernetes address NetBox gives it. A `planned` or `staged` `amt` device without `oob_ip` gets a `Machine` at `attested_address`, since AMT shares the host's address, when talos-attest recorded it from an intake pass less than 15 minutes ago and it is a bootstrap address that no anchor or boot VIP holds (`BOOTSTRAP_CIDR` and the anchors' addresses in `clusters/folly/config/anchor-topology.json`). Rufio then powers the run on, and the `Workflow` pins the address in `lolwtf.ca/bmc-address`, so the `Machine` stays until the run finishes. A pass during the run moves the pin to a new bootstrap lease, or ends it once the device attests from its own Kubernetes address. Any other `planned` device boots by hand, and its journal says so: its `Workflow` has no `bootMode`, and it gets a `Machine` only with an explicit `oob_ip`. Once the status leaves `planned`, the `Machine` dials the device's own address.
- A failed retirement is journaled once and the device stays `decommissioning`. The owner moves it on by hand. A device taken out of `decommissioning` before its retirement finished has that run deleted.
- The webhook is a "reconcile now" and nothing more. The event rule has no condition, so it rings on the controller's own writes too; those passes find nothing to do.
- `Workflow` objects older than 7 days are deleted. A device whose status leaves the exported set (`offline`, `inventory`, deleted) loses its `Hardware` and `Machine` on the next pass.
- `provision` and `wipe` erase every partition of the system disk, `META`, `STATE`, `EPHEMERAL`, `ETCD` and the `data` volume, as soon as Rufio reaches the BMC.

## Install

Installs are on: `nix/hosts/spore.nix` sets `homelab.fleetController.installs`. With the option off, no `Workflow` installs and `/render` refuses every call. A `provision` of a class whose class inputs say `worker`, or `controlplane` with [control planes](#control-planes) on, carries `install=true` and the class's `installer_image` in its `hardwareMap`, when the attest step runs. At the end of the intake talos-attest posts `{serial, uuid, node, class, code}` to `/render`, signed as HMAC-SHA512 hex of the body in `X-Fleet-Signature`. The controller answers 409 unless the device is `planned` or `staged`, its `last_workflow` is an unfinished `provision` run with `install=true`, its `smbios_uuid` is unset or the request's, and the code is unspent. It renders the config with `talosctl gen config --with-secrets` from the class's entry in `clusters/folly/fleet/class-inputs.json`, which `mise run render-class-inputs` writes from the Talos root, the worker subset of the secrets bundle in spore's sops file, and the device's name, address, install disk and TPM in NetBox. It refuses a control plane unless control planes are on. It writes `talos/<uuid>/<code>.yaml` under `/var/lib/fleet-controller`, and answers 201. The `install` action runs the installer with the code in META, and the node's first boot fetches the file by it.

nginx serves `/talos/config` on spore, and capsule and forge pass it to spore's Anchor address on port 8447 (`nix/lib/talos-config.nix`). Both Anchor-network legs, the render call and the proxied fetch, are plain HTTP. The controller reads nginx's log of the location every two seconds. A whole GET of the file's bytes deletes it and sets the device `active` with `attest_consumed_at`; a range, a HEAD or an aborted fetch deletes nothing. A served, expired or replaced code stays spent for a day, so a replayed render call is refused. A 404 for a machine with a waiting file is journaled at most every ten minutes. A file nobody fetched is deleted after two hours, a control plane's after 30 minutes. Each step is an audit line, `fleet.render`, `fleet.release` or `fleet.expire`.

### Control planes

Control-plane installs are off: `homelab.fleetController.controlPlanes` defaults to false. With it off, spore decrypts only the worker subset, a control plane's `provision` wipes the disk and installs nothing, and `/render` answers 409 with "the owner renders". With it on, the controller loads `fleet-controller/bundle` from spore's sops file, the full secrets bundle with the cluster's CA keys, and refuses to start if a CA key is missing or the bundle's worker values differ from the worker subset's. A device whose class is `controlplane` in `class-inputs.json` then renders from the bundle, the way the Talos root renders it, into the same burn-on-read file with the same modes. The device at `API_SERVER_IP` is the control plane the Talos root's `talos_cluster` bootstraps etcd on: its `provision` installs nothing, and `/render` refuses it with 409. A control plane without an address gets the same: no install and a 409. A bound intake of a control-plane class is never auto-provisioned; the owner sets its `desired_action`. With the option on, `modelMap` may map no model to `controlplane`, which an assertion in `nix/services/fleet-controller.nix` enforces. Any other control plane boots its config, finds etcd through the running cluster and joins it. Nothing here bootstraps etcd.

Once NetBox holds the node `active` and the export is merged, the Talos root takes it over as `talos_machine.joining`, after `talos_cluster`. While the device is `staged`, the root leaves it alone, as it leaves a worker (`enrolling` in `clusters/folly/talos/talos.tf`). An active control plane joins the API server's serving-certificate SANs on every control plane, so the export's pull request also needs `mise run render-class-inputs`. The render parity check fails until it has it.

With the option on, spore holds what mints a control plane, a talosconfig or a Kubernetes admin certificate for folly. Root on spore owns the cluster then. spore's age key decrypts `fleet-controller/bundle` from git whatever the option says. The option decides whether sops-nix writes the bundle under `/run/secrets` and the controller loads it.

## Intake

Before HookOS's agent waits for work, it posts the machine's MAC, serial, UUID, model and disks to `/intake`, with the switch port that the switch's LLDP frame names, when one arrives within 35 seconds. A malformed body is 400. The machine's address is the `X-Real-IP` header that every anchor's nginx sets, which the controller takes only from the three anchors' Anchor addresses (`FLEET_PROXY_ADDRESSES`). One MAC may call every ten minutes and one address ten times an hour, and at most twenty intakes are made an hour; more is 429. A known MAC's call holds no slot, so a stranger's post for it never locks the machine's own out. Each call's report, its time, address, serial and LLDP port, goes on the controller's `Hardware` that holds the MAC as `lolwtf.ca/intake-*` and `lolwtf.ca/lldp-*` annotations, and replaces the one before it. The intake is unauthenticated, and its MAC and serial are public, so the report is for diagnostics: no `Machine`, cable or port check follows from it. A MAC on a NetBox interface or a `Hardware` answers 200 `known` and creates nothing else. Otherwise the controller creates `Hardware <mac>`, labelled `lolwtf.ca/intake=true`, on the first NVMe disk, else the first disk that is no USB stick. It then creates `Workflow intake-<mac>-<unix seconds>`, a `provision` run with only `attest`, which boots nothing since the agent is connected, and answers 201. It never creates a NetBox device; talos-attest does, on a pass. An intake whose run failed is deleted after an hour, and one whose MAC no device holds after 24 hours.

When the intake run has finished and its device is `staged` and `attested`, a pass binds it. A device named `intake-<serial>` takes the stub with its serial, else the oldest serial-less stub of its model's class, and the stub's name; the stub is deleted. A device that talos-attest made of a stub keeps its name. Only a MAC talos-attest wrote counts: an attested device without one waits, and an intake's claimed MAC never reaches NetBox. `homelab.fleetController.modelMap` gives the class, BMC and install disk; an unknown model gets neither a class nor an install disk, since the intake's disks are a claim. The address is the stub's reserved one, else the lowest free one of `K8S_NODE_CIDR` that is neither the gateway nor the API server. The intake pass gives the switch port: talos-attest records `attested_switch` and `attested_switch_port` from the LLDP frame the session's AK signed, and the port is `Port <n>` of the NetBox switch whose MAC is that chassis ID, from a pass no older than the intake's `Workflow`. On the provisioning station's port, `homelab.fleetController.intakePort`, which the module reads from `quarantine_ports` in `terraform/network/unifi/folly/bootstrap.tf`, no port check applies and only a stub's `expected_port` is cabled. Elsewhere, a stub's `expected_port` must match the attested port, and another port, or none, binds nothing and the journal says why. A port the intake claimed that differs goes in the binding's journal entry. A class other than a control plane's and an address set `desired_action` to `provision`, whose run waits in HookOS without Rufio. Later passes cable a node with no cable to the rack port an intake pass attested within the hour, and journal a node attested off its `expected_port`. Each step is journaled, with the audit lines `fleet.intake`, `fleet.bind` and `fleet.autoprovision`.

A stub's address is an IP address with the status `reserved`, the stub's name as its DNS name, and no interface, since a stub has no MAC; the binding assigns it and makes it the primary IPv4.

## How it works

Every two minutes, and two seconds after the webhook rings, the controller lists the site's devices with the role `kubernetes-node` and the status `planned`, `staged`, `active`, `failed` or `decommissioning`, with each device's first physical interface that has a primary MAC. It server-side-applies a `Hardware` whose iPXE script chains the signed HookOS UKI with the command line the UKI bakes in, and a `Machine` at the device's `oob_ip`, or its own address for AMT, with the Secret `bmc-<bmc_type>`. The `Hardware`'s `allowPXE` and `allowWorkflow` are true while the device has an unfinished `Workflow` and false otherwise: the controller turns them on before it creates a run, its `Workflow`s leave Tinkerbell's `toggleAllowNetboot` off, and each pass overwrites a value set by hand. The `Workflow` carries `wipe`, `attest`, `retire`, `install`, `installer_image`, `attest_url` and `ntp_server` in its `hardwareMap`, which the Template's actions read. Each decision is one JSON audit line on stdout with `event` `fleet.workflow` or `fleet.retire`. [talos-attest](talos-attest.md) does the attestation inside the run. The controller releases an installed node's config.

## Operate

| Signal | Meaning |
| --- | --- |
| `/healthz` answers 503 | No pass succeeded within three intervals; `journalctl -u fleet-controller` on spore names the error |
| `fleet_reconcile_errors_total` rises | A pass ended with an error; the pass still did what it could |
| A device's journal says a run waits | The device lacks a MAC or `install_disk` in NetBox |
| `FleetInstallPending` fires | A rendered config has waited 30 minutes for its node's first boot; the install or the boot failed |
| `fleet_install_unreleased` is above 0 | nginx served a config and NetBox refused the release; the device's journal says why, and the controller retries |
| `fleet_install_renders_refused_total` rises | talos-attest asked for a render the device's state forbids; the controller's journal names the gate |
| `fleet_intake_limited_total` rises | Machines intake faster than the rate limits allow; a flood of claims, or many boxes at once |

## Reference

- Source and environment: `apps/fleet-controller/`
- spore: `nix/services/fleet-controller.nix`
- Template and Secrets: `clusters/folly/tinkerbell/`
- Class inputs: `clusters/folly/fleet/class-inputs.json`, and the pinned talosctl in `apps/fleet-controller/talosctl.nix`
- Render parity: `.github/scripts/talos-render-parity.sh`, which adds a staged control plane, `joining-cp`, to the Talos root it compares
- Alerts: `clusters/folly/monitoring/fleet-controller-rules.yaml`
- Image: `ghcr.io/jonpulsifer/fleet-controller`, for a boot plane that runs as containers
