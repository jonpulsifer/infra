---
title: From purchase to workload identity
description: A security engineering brief on folly's receiving, inventory, provisioning and identity controls, their evidence and their tradeoffs.
---

This brief explains how a purchased machine becomes a folly Kubernetes node and receives workload credentials. Security engineers use it to assess authority, evidence and residual risk. It describes the repository's design; it is not a live attestation report.

The design gates installation on an approved device identity, acceptable boot evidence and lifecycle authorization. Its assurance depends on receiving evidence and the management plane. It does not establish complete supply-chain integrity or continuous runtime integrity.

## Follow one machine

![Purchase, receiving, declaration, attestation, installation and identity, with the authority at each boundary](../assets/purchase-to-identity.svg)

| Stage | Authority and evidence | Result and limit |
| --- | --- | --- |
| Purchase and receive | The owner checks the delivered chassis, its TPM endorsement keys and install disk serial against independent receiving evidence. | A candidate inventory binding. An invoice or a self-reported serial alone cannot authenticate a TPM. |
| Declare | The owner reviews `clusters/folly/inventory/nodes.yaml` through Git. Atlantis applies `terraform/netbox/folly`. | A planned NetBox device with approved keys, disk and expected port. A record expresses intent, not physical proof. |
| Prepare and boot | The owner prepares firmware and Secure Boot keys. Boot services on spore supply signed iPXE and HookOS, the installation environment. | Firmware accepts signed boot code. This does not authorize configuration release. |
| Attest and admit | fleetd checks TPM possession, a fresh quote, the boot event log, approved keys and a signed network report. | An eligible machine can receive device certificates and installation authorization. Reported switch location is not authenticated physical location. |
| Install and configure | Tinkerbell executes the workflow. Disk checks, the current boot's pass marker and a TPM-delivered code gate the provision's wipe. | Talos installs and fetches configuration over HTTPS. After unwrapping, the code is a bearer secret. |
| Join and identify | fleetd approves the node's matching bootstrap certificate request. SPIRE admits an agent and issues credentials for registered workloads. | Cluster membership and workload identity. Each service still needs its own authorization policy. |
| Recheck and retire | fleetd evaluates later boot evidence and reconciles owner actions in NetBox. | Quarantine or retirement restricts future access. Existing credentials and copies of disk data need separate accounting. |

NetBox `active` records configuration release. Kubernetes readiness is a separate observation. The [lifecycle overview](../platform/node-lifecycle.md) and [provisioning runbook](../runbooks/provision-a-node.md) describe the operating sequence.

## Receiving is the first trust decision

A Trusted Platform Module (TPM) protects device keys. Its endorsement key (EK) identifies the TPM; a manufacturer certificate does not bind that TPM to the purchased chassis.

The owner needs a receiving scan or an authenticated supplier record that ties the chassis serial to its EKs. A validated platform certificate counts only when it establishes that relationship. The repository defines this prerequisite; it does not implement purchase-order verification or a supplier provenance service.

Unknown machines and planned devices without an approved binding wait as claims. A claim supplies candidate hashes for comparison and authorizes nothing. Approving those hashes from the claim alone defeats the independent receiving check.

fleetd accepts a binding only when NetBox's changelog attributes its latest change to the configured Terraform user. This gives an accountable writer, not tamper-proof provenance. NetBox administrators and the Terraform credential remain trusted. The Terraform user can manage permissions, including its own.

The [inventory contract](inventory.md#approved-tpm-keys) defines the binding. [NetBox permissions](../platform/netbox.md#users-and-tokens) define who can change it.

fleetd reads NetBox over HTTP on the Anchor management network. Binding provenance therefore also trusts that network path; the changelog is not an end-to-end signed record.

## What the checks establish

Secure Boot checks signatures before execution. Measured boot records events in platform configuration registers (PCRs). fleetd verifies a fresh TPM quote and replays the event log against those registers. Credential activation binds the attestation key to the EK's TPM.

The intake policy requires the HookOS signing authority. The accepted authority policy does not impose an exact boot-image version: `boot_applications` is empty. A correctly signed older image can therefore remain acceptable. Measurement also depends on firmware measuring the relevant events correctly.

The Local Device Identity (LDevID) certificate identifies a TPM key. A locally certified attestation key (LAK) signs later boot evidence. Neither certificate alone authorizes a wipe. Admission checks the declaration and lifecycle state separately.

The signed network report protects the reported observation. Link Layer Discovery Protocol (LLDP) does not authenticate the switch. Disk serial matching limits accidental selection of the wrong disk; it does not cryptographically authenticate storage hardware.

The install code reaches the approved TPM through credential activation. Talos later presents the unwrapped code over HTTPS without a fresh TPM proof. A complete response consumes it; an incomplete response permits retry until expiry. Theft before consumption remains a risk.

Consumption follows TCP acknowledgement, not proof that Talos persists the configuration. Power loss in that gap requires a new provision.

Workers provisioned by fleetd receive per-node bootstrap tokens. fleetd checks the requested node name before approving the initial kubelet certificate, then deletes the token. Compromise of fleetd's approval credential bypasses that application-level restriction.

SPIRE issues SPIFFE Verifiable Identity Documents (SVIDs) for registered identities. Its node attestors do not repeat fleetd's boot-policy evaluation. Workload selectors and resource authorization remain separate checks. [The detailed design](folly-design.md) maps these controls to source and tests.

## Off-the-shelf building blocks and tradeoffs

PXE, UEFI HTTP boot and BMC control occupy different layers. Firmware and management controllers are not necessarily open source. The open-source stack composes these interfaces with inventory and workflow services. The comparisons below assess what each building block contributes, not a benchmark of competing products.

| Approach | Useful capability | Cost or missing assurance | Position at folly |
| --- | --- | --- | --- |
| Raw PXE with DHCP/TFTP and an installer | Broad network-boot support and a small initial service set. | Boot selection alone supplies no independent chassis-to-TPM binding or per-device secret-release policy. Scripts must supply lifecycle decisions. | PXE starts the current path; signed iPXE and HookOS add boot verification. |
| iPXE with HTTPS and image verification | Scriptable boot, authenticated server transport and signed-image enforcement when configured. | Embedded trust roots, build options and scripts need maintenance. Server authentication does not authenticate the client machine. | Folly builds signed iPXE; fleetd supplies device admission. |
| Native UEFI HTTP/HTTPS boot | Firmware fetches the boot image directly; compatible machines can avoid an iPXE stage. | Firmware support, certificate provisioning and recovery need target-hardware validation. HTTP alone provides no TLS protection; Secure Boot remains a separate check. | An alternative boot transport, not the declared folly path. |
| BMC or AMT power and boot control | Remote reset and boot selection when the installed OS cannot respond. | A privileged management interface adds credentials, firmware and network exposure. Control of power does not prove an acceptable boot. | Rufio drives AMT for lifecycle actions. |
| Stock Tinkerbell workflows | Reusable boot, power and installation orchestration. | A workflow needs an admission decision and trusted inputs. Merely completing a workflow establishes no independent receiving provenance. | fleetd creates the authorized workflow and gates configuration delivery. |
| Direct Talos installation | A shorter installation path for a Talos-only fleet. | Receiving, remote recovery, authorization and identity withdrawal still need owners. | An operational alternative; it does not supply the current fleet contract. |
| NetBox plus fleetd policy | Joins declared inventory, observed evidence and lifecycle actions in an auditable path. | Custom security code, policy maintenance, privileged credentials and integration tests become the owner's responsibility. | The lab's integration layer over the reusable components. |

[iPXE cryptography](https://ipxe.org/crypto) documents its configurable transport and image checks. [UEFI network protocols](https://uefi.org/specs/UEFI/2.11/24_Network_Protocols_SNP_PXE_BIS.html) describe firmware HTTP boot. [Rufio](https://tinkerbell.org/docs/v0.22/services/rufio/) documents power and boot control. These capabilities do not certify the lab's configuration.

## Security and availability tradeoffs

| Decision | Benefit | Accepted cost |
| --- | --- | --- |
| Independent EK approval before first admission | A copied serial or MAC cannot alone win enrollment. | Receiving and board replacement need trustworthy human evidence. |
| Signing-authority policy | Signed releases can change without a PCR allow list for every image. | No exact-image version floor; an older accepted image remains possible. |
| TPM delivery followed by a bearer config code | Works with Talos's config-fetch interface. | The unwrapped code needs protection until consumption or expiry. |
| One fleetd process and an external anchor | Admission and installation share policy; boot services remain available while folly is down. | spore and fleetd concentrate authority. Worker token creation still requires the Kubernetes API. |
| YubiKey device-identity signer | The private signing key stays outside ordinary host storage. | An authorized compromised host can still request signatures. |
| Refuse admission when inventory is unavailable | Missing evidence cannot authorize a new install. | A NetBox outage blocks provisioning. |
| Preserve registrations on malformed or unexpectedly broad withdrawal | Reduces accidental fleet-wide loss of identity. | Stale access can persist during faults until the owner intervenes. |
| Cordon on an authenticated worker policy failure | Prevents new scheduling without automatically terminating workloads. | Existing pods continue; cordon is not network isolation. |

Explicit wipe and retirement actions have their own authorization paths. The attestation gates above describe provisioning; they are not a claim that every destructive action requires a successful boot check.

Recovery outside folly does not imply security isolation from either cluster. Shared operator age keys and vault access let cluster administrators reach management secrets. The [detailed threat model](folly-design.md#7-threat-model) describes that path to signing and binding authority.

## How much confidence the evidence supports

Source review establishes intended control flow. Simulator tests exercise protocol rejection and state transitions. Integration tests exercise cooperating services. A hardware fixture checks a specific input; it is not current evidence from a running node.

| Review question | Evidence to inspect | Remaining acceptance work |
| --- | --- | --- |
| Can a substitute TPM enroll? | Binding and intake tests under `apps/fleetd/attest/`, plus the independent receiving record. | Challenge first admission on target hardware with the wrong EK. |
| Can replay or a spent code release configuration? | Attestation simulator cases and `apps/fleetd/fleet/install_test.go`. | Exercise interrupted delivery and recovery on the actual boot path. |
| Does a machine join under its own name? | `apps/fleetd/fleet/joincsr.go` and the cluster's bootstrap approval policy. | Attempt a mismatched node name and observe rejection. |
| Does retirement end access? | SPIRE export tests, registration applier tests and the retirement workflow. | Observe both node attestors, all registration owners and credential expiry. |
| Can management recover independently? | Anchor configuration and provisioning runbooks. | Restore the management dependencies while folly is unavailable. |

Withdrawal removes fleet-owned registrations. Another registration owner can retain a withdrawn agent; explicit retirement bans matching agents on sight, subject to the bulk-withdrawal safeguard. Issued SVIDs persist until expiry. A disk copy can retain a kubelet client certificate that Kubernetes cannot revoke individually. Wipe completion and canary checks do not prove physical sanitization or erase backups.

The [threat model](folly-design.md#7-threat-model) records assumptions and attack boundaries. The [acceptance criteria](folly-design.md#8-failure-behavior-and-acceptance) require deliberate rejection tests and a separate readiness observation. A production assurance claim needs those observations alongside the repository evidence.
