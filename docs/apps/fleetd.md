---
title: fleetd
description: The Go service on spore that attests folly's machines and nodes, issues their LDevIDs, drives Tinkerbell's installs from NetBox, and serves each first boot's Talos config once.
status: live
---

fleetd decides whether a machine may become a folly node, gives it the means to become one, and keeps watching it. It checks a machine's TPM evidence against `apps/fleetd/attest/policy.yaml`, issues the node's LDevID, a TPM-resident key with a certificate from spore's YubiKey CA, and its LAK certificate. It turns NetBox's `kubernetes-node` devices into [Tinkerbell](../platform/nixos/tinkerbell.md)'s objects, renders the Talos config an install fetches, and cordons a node it quarantines. NetBox is its system of record, and the owner acts there.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Device flow | `https://enroll.lolwtf.ca/attest/v1/attest` and the session routes under it | HookOS on a netbooting machine, at spore's bootstrap address |
| Install config | `https://enroll.lolwtf.ca/talos/config?uuid=<uuid>&code=<code>` | A node's first boot from disk |
| LDevID and verdict lookups, renewal and daily check | `http://<SPORE_IP>:8444/devid/<serial>`, `/verdict/<serial>`, `POST /v1/renew` | folly's `K8S_NODE_CIDR` and `CILIUM_POD_CIDR` |
| Webhook and metrics | `http://<SPORE_IP>:8446/webhook`, `/healthz`, `/metrics` | NetBox's event rule and the Anchor network |
| Admin API | `https://spore.<tailnet>:8445`, `GET /machines` | Tailnet logins in `ATTEST_APPROVERS` |
| NetBox | A device's `desired_action` and `status` | The owner |

`SPORE_IP` and `SPORE_BOOTSTRAP_IP` are in `clusters/folly/config/anchor-topology.json`. The anchors' CoreDNS answers the enrollment name with spore's bootstrap address, and a public certificate covers it, since Talos trusts only its bundled roots before it has a config.

| `desired_action` | The run |
| --- | --- |
| `provision` | Netboot HookOS, which attests; wipe the system disk, install Talos and boot the disk. A class fleetd does not render is wiped and stays in HookOS |
| `attest` | Netboot HookOS, which attests, and boot the disk again |
| `wipe` | Wipe the system disk and stay in HookOS |

A device in `decommissioning` gets the `retire` run, which wipes and powers the node off, then goes `offline`. [Provision a node](../runbooks/provision-a-node.md), [Reprovision a node](../runbooks/reprovision-a-node.md) and [Retire a node](../runbooks/retire-a-node.md) are the procedures.

## Limits

- An approved EK binding is only as true as its evidence. fleetd admits the TPM the nodes file names, so the receiving scan or the supplier's record that ties the chassis serial to its EKs is the trust source. A serial that SMBIOS or Redfish reports, a pending claim and the console of a box nobody checked prove nothing.
- Rendered configs live in a tmpfs, `/run/fleetd/configs`, which a restart of fleetd keeps and a reboot of spore drops; that node's provision then runs again.
- One issuer signs every LDevID. The bundle `terraform/pki/certs/folly-devid-ca.pem` keeps capsule's, forge's software and spore's CAs, so an LDevID another CA issued verifies until its node renews it from spore's.
- A TPM 1.2 node, or class `worker-g2`, cannot attest, so it never installs from here.

## How it works

HookOS attests on every boot, before tink-agent waits for work: the agent image's entrypoint sets the clock from `fleet_ntp_server` and runs `tink-attest` against `fleet_attest_url` (`images/tink-agent-autoid`). The machine's NetBox device, found by its SMBIOS serial, must be `planned` and carry an approved EK binding, which the nodes file declares and `terraform/netbox/folly` projects into `approved_ek_hash` and `approved_ek_hash_ecc`. A binding counts only when NetBox's changelog shows that Terraform's user, `homelab.fleetd.bindingAuthor` in `nix/services/fleetd.nix`, made its newest change. Every approved EK must be sent, match and activate its credential; a manufacturer certificate admits nothing on its own. A device without a binding, and a serial NetBox lacks, wait as a claim that authorizes nothing, and other EKs are refused and journaled on the device without a write. fleetd checks each EK certificate against `apps/fleetd/attest/roots/`, activates a credential, replays the quoted event log against the policy, reads the device and its changelog again, and issues both certificates only while it holds the binding the session started with. The pins `ek_hash` and `ek_hash_ecc`, which fleetd alone writes, then hold the binding alone. Only a check the TPM signed for becomes a verdict. A transport error, a timeout, a missing TPM or evidence before a TPM proof never quarantines and writes nothing. Neither does a failed intake while no run expects the machine in HookOS, such as a worker that fell back to PXE: fleetd refuses it, journals the device and counts it, and the node keeps its identity.

The signed confirm of an intake pass that matched a binding admits the device in the same process, once fleetd has read the binding again. fleetd fills in nothing: it refuses a device that lacks a field `terraform/netbox/folly` declares (`talos_class`, `install_disk`, `bmc_type`, `tpm_version`, `amt`, `secure_boot_expected`, `expected_port` or the primary address) and a device whose attested LLDP port is not its `expected_port`, and writes only the journal. It then starts the provision Workflow, without a boot mode since the machine waits in HookOS, when the owner set `desired_action` to `provision`, or when the worker never ran a Workflow and auto-provision is on. A control plane waits for the owner. fleetd renders the config with talosctl from `clusters/folly/fleet/class-inputs.json` and the worker secrets, and answers 32 random bytes wrapped to the TPM. The entrypoint leaves the code and a mark of the pass in `/worker/fleet`. The Template wipes a provision's disk only with both, and the install action writes the code to `META`. fleetd starts a new run only once the render's gates pass. The first complete GET of the config burns it, and fleetd sets the device `active` after the answer; HEAD and conditional requests are refused. An unread config goes after two hours, a control plane's after 30 minutes.

On a running node, `tpm-reattest` sends a LAK-signed quote daily, and needs no binding; a `planned` device gets no renewal: a renewal from 30 days before expiry, else the daily check. A boot that misses `renew_required_authorities` quarantines a worker, which revokes its LDevID and cordons it as `clusters/folly/tinkerbell-access/fleet-controller-cordon.yaml`'s account. A control plane only raises an alert. PCR 0 is kept per BIOS version in `pcr0_by_bios`, and a network fact counts only when the session's AK signed it. [Identity](../platform/identity.md#renewal) has the renewal and the owner's quarantine lift.

Each pass also writes `/var/lib/fleetd/spire-nodes.json`, the nodes that spore's SPIRE server registers: each `active` device with a passing verdict, with its name and its `ek_hash` and `ek_hash_ecc` pins. A device that is decommissioning, failed, quarantined, offline or gone from NetBox is absent. fleetd holds no SPIRE credential and never calls the server. A root unit on spore, `spire-server-fleet-entries`, reads the file and owns the registration entries whose IDs start with `fleet-`; it deletes a node's entries and evicts its agent when the node leaves the file, and it changes nothing when the file is malformed. [Identity](../platform/identity.md#fleetd-entries) has the boundary with the entries that Nix declares.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `EnrollmentNameNotServed` | fleetd is down, or its certificate lapsed | [Provision a node](../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `FleetdDevIDNotServing` | The DevID listener on 8444, which every renewal reaches, does not answer | Read `journalctl -u fleetd` on spore |
| `TalosAttestUnattendedBootFailed` | A node booted HookOS unprompted and failed attestation; nothing was recorded | Read the device's NetBox journal |
| `BootFilesNotServed` | dnsmasq or nginx on spore does not serve iPXE or HookOS | [Provision a node](../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `FleetInstallPending` | A rendered config has waited 30 minutes for its node | [Provision a node](../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `TalosAttestQuarantined` | A node's newest verdict is a quarantine | [Provision a node](../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `TalosAttestWaitingForApproval` | An intake waits for an approved EK binding | [Provision a node](../runbooks/provision-a-node.md#approve-a-machines-eks) |
| `TalosAttestNotChecked`, `TalosAttestLDevIDExpiring` | A node's daily quote or renewal fails | [Add a TPM node to SPIRE](../runbooks/add-a-tpm-node-to-spire.md#if-something-goes-wrong) |
| `TalosAttestCheckFailed`, `TalosAttestPCR0Changed` | A daily check failed, or PCR 0 moved at one BIOS version | Read the device's NetBox journal |

## Reference

- Source, environment and HTTP contract: `apps/fleetd/`
- spore: `nix/services/fleetd.nix` and `nix/services/talos-boot.nix`
- Template and Secrets: `clusters/folly/tinkerbell/`
- HookOS agent: `images/tink-agent-autoid`; renewal image: `ghcr.io/jonpulsifer/tink-attest`
- Alerts: `clusters/folly/monitoring/fleetd-rules.yaml`
- DevID CAs: `terraform/pki/devid.tf` and `terraform/pki/devid-ca.tf`
