---
title: From purchase to workload identity
description: Follow a machine from receiving through NetBox and installation, then weigh Tinkerbell, direct BMC operation and simpler TPM enrollment.
---

The purpose of this work is to give workloads an identity rooted in hardware we accept into the lab. We verify the machine's TPM, enroll a device identity, and let SPIRE use that identity to admit the node and identify its workloads. Installing Talos is one step toward that result.

NetBox is the record that fleetd reads. fleetd chooses and authorizes the work; Tinkerbell supplies the boot and workflow machinery that carries it out. The DIY proposal separates those jobs further: a small boot image and a provisioning-time tool enroll the machine, while a narrow identity service and SPIRE support it afterwards.

This brief follows a TPM 2.0 worker through the current path, then compares it with a DIY identity bootstrap stack. The alternatives and enrollment improvements are proposals, not enabled provisioning paths. Security engineers can use the linked source and tests to assess the design; this page does not certify a running machine.

## Follow one machine

### Receive it and create its record

We begin with the delivered chassis. We check its label and hardware, identify the disk we intend to erase, and may obtain its TPM endorsement-key hashes through a trusted receiving scan or supplier record. fleetd admits a declared serial without them when every EK carries a maker certificate that chains to its trusted roots; the hashes pin a TPM or cover one with no such certificate. An endorsement key, or EK, identifies the Trusted Platform Module; it does not by itself tell us which chassis contains it.

For folly nodes, we enter the static details in `clusters/folly/inventory/nodes.yaml` through a pull request. Atlantis applies those values into NetBox as a device with status `planned`. This is how we populate the NetBox record today; lifecycle requests then come from the owner in NetBox. The [inventory contract](inventory.md) describes which fields Git owns and which observations fleetd adds.

### Choose what the machine should do

Suppose the device is a supported Talos worker and we request `desired_action=provision`. NetBox sends fleetd a webhook, which prompts fleetd to reread the inventory. fleetd also reconciles periodically, so a webhook is a notification, not an executable job description.

The device's `class` selects an entry in `clusters/folly/fleet/classes.json`. That entry chooses the workflow template, installer image and boot policy. The requested action determines whether this run attests, wipes or installs; the device's disk and identity fields constrain where that work may happen.

| NetBox value | How fleetd uses it |
| --- | --- |
| `class` | Selects the class's OS, workload, template, pinned installer and verification policy. |
| `desired_action` | Requests provision, attest or wipe. The `decommissioning` status separately requests retirement. |
| MAC address | Connects the machine to its Tinkerbell Hardware record and boot script. |
| `install_disk`, `install_disk_serial` | Select the intended disk and require its serial to match before destructive work. |
| `bmc_type`, management address | Select the power-control connection; the implemented provider here is Intel AMT. |
| Approved EK hashes (optional) | Constrain which TPM may enroll as this planned device. |
| Primary address, `expected_port` | Supply the node address and the expected connection used in admission checks. |

A new device has no recorded MAC yet, so the inventory alone is not enough to submit a runnable workflow. fleetd waits for the first HookOS boot to identify the machine. An explicit request can remain pending while we prepare and boot it.

### Boot into the installation environment

For the first installation, we prepare firmware and start the machine's PXE boot. PXE leads to signed iPXE and then signed HookOS from spore. HookOS is the temporary Linux environment that can inspect hardware, wipe disks and run the Talos installer. Its successful attestation lets fleetd record the machine's MAC in NetBox.

On a later explicit run, when the MAC and AMT connection are known, fleetd can submit the workflow first and have Rufio request power and one-time PXE boot operations. AMT gets the machine into the installation environment; the disk actions still run on the machine itself.

HookOS contacts fleetd before its Tinkerbell agent executes the installation. fleetd checks that the TPM matches the approved inventory binding, or without one that every EK has a maker certificate, proves possession of its keys, and supplies fresh, acceptable boot evidence. It also checks the declaration and a signed report of the observed switch port. The signature protects the report; LLDP does not authenticate the physical switch or cable location. If admission fails, a provision receives no install code and its disk wipe cannot proceed.

A first installation can also start without an explicit action: an eligible planned worker can boot HookOS, pass admission and trigger auto-provision when enabled. That path requires no earlier workflow and no conflicting request. Control planes do not automatically provision. [The provisioning runbook](../runbooks/provision-a-node.md) gives the operating steps and exceptions.

### Run the job and bring the node into service

For an admitted first installation, fleetd creates the Tinkerbell Workflow from the class and device inputs, then records its name in NetBox's `last_workflow`. The machine is already in HookOS, so this path needs no second boot request. fleetd allows one unfinished run per device and adopts an existing run if its NetBox record needs a retry.

fleetd renders the Talos configuration and delivers an install code to the proven TPM. The workflow checks the disk serial and the current boot's authorization before wiping, installing Talos and arranging the next disk boot. Tinkerbell records action progress while fleetd watches for completion and failures.

Talos boots from disk and exchanges the code for its configuration over HTTPS. fleetd consumes the code after the response is acknowledged and marks the NetBox device `active`. That records configuration delivery; Kubernetes readiness is checked separately. Workers provisioned by fleetd also pass a node-name check when fleetd approves their initial kubelet certificate request.

Once the node is eligible, SPIRE can issue identity credentials to its registered workloads. Later boot checks and NetBox lifecycle changes can restrict future issuance. Retirement coordinates disk erasure, power state and cluster cleanup, although credentials already issued can remain valid until expiry.

![Initial PXE boot reaches HookOS; fleetd records the proven machine’s MAC, admits the machine and creates its installation workflow](../assets/purchase-to-identity.svg)

## What Tinkerbell contributes

Tinkerbell gives us a common way to boot a machine, deliver ordered actions, record progress and control power. Here it also brings an embedded Kubernetes API and etcd, Smee for boot scripts, Tink's controller and server, a node agent, and Rufio for AMT. The [Tinkerbell page](../platform/nixos/tinkerbell.md) shows the deployed components.

The complete lifecycle still needs substantial lab code. fleetd handles admission, conflicting requests, workflow adoption, timeouts, configuration delivery and NetBox updates. Our template supplies disk checks, installer preparation and boot handling. Keeping Tinkerbell means maintaining these integrations as well as the upstream services; removing it means deciding which responsibilities become manual and which need replacement code.

Raw PXE or native UEFI HTTP boot changes how an image reaches the machine. Direct AMT calls change who requests power and boot operations. Neither supplies the executor that runs disk actions or the controller that decides whether a failed installation is safe to retry. iPXE can also provide HTTPS and image verification when configured, while UEFI HTTPS boot depends on the target firmware's support. See [iPXE cryptography](https://ipxe.org/crypto) and [UEFI network boot](https://uefi.org/specs/UEFI/2.11/24_Network_Protocols_SNP_PXE_BIS.html).

## What removing Tinkerbell would look like

The proposed replacement has no Tinkerbell and no full fleetd daemon. We build our own small, signed bootstrap image, use a provisioning-time verifier and installer, and keep a narrow attestation/renewal service online. SPIRE remains on spore and on the workload nodes. TPM verification, Local Device Identity (LDevID) enrollment and workload identity remain requirements throughout.

### A bootstrap image with one job

An Alpine-based initramfs, or a similarly small Linux image, boots into RAM and runs our attester. It needs working network, storage and TPM drivers, a trusted verifier endpoint, and the tools for the chosen installer. We can package its kernel, initramfs and command line as a signed Unified Kernel Image (UKI). The attester and any later executable downloads must be covered by that trust policy. [Alpine's diskless mode](https://wiki.alpinelinux.org/wiki/Diskless_Mode) is a suitable starting point, not a complete attestation system.

The image reads the TPM's EKs, creates an attestation key and an LDevID key inside the TPM, and sends evidence to the trusted provisioning tool. That tool checks the approved inventory binding, possession proof and fresh boot evidence, then obtains device certificates from the lab's DevID issuer. The image carries public trust anchors, never the issuer's private key. Much of this protocol already exists in `apps/fleetd/client/` and `apps/fleetd/attest/`; reusing that code does not require running fleetd as the lifecycle controller.

The owner can boot the machine through AMT or its console. After identity enrollment, a fixed install routine accepts a short-lived authorization for this machine, boot, disk and installer. It prepares the runtime identity material, installs Talos and finishes the node's initial join. A failed attempt stops for an explicit retry. We still need durable authorization receipts and safe disk checks, but we do not need a general workflow queue, arbitrary action templates or automated power recovery.

### Keep the identity working after reboot

Generating an LDevID certificate is only half the job. The installed OS also needs its certificate chain and TPM-wrapped key blobs so the SPIRE agent can load the same device key after a cold boot. Certificates in TPM nonvolatile memory alone are insufficient. Today our agent initializer fetches the package from fleetd; the proposal instead delivers it to persistent local storage and makes the initializer load it there.

SPIRE's node attestor proves possession of the LDevID key and its relationship to the TPM. SPIRE then applies node registrations and workload selectors before issuing short-lived workload credentials, called SVIDs. The LDevID is the device credential; SPIRE issues the separate workload credentials. A pod does not receive the device's private key. The [SPIRE TPM DevID plugin](https://github.com/spiffe/spire/blob/main/doc/plugin_agent_nodeattestor_tpm_devid.md) describes this proof.

The small continuous service handles later TPM boot checks, LDevID and attestation-key certificate renewal, and identity eligibility or withdrawal. It retains issuer/verifier state and lifecycle access, but has no BMC, disk installation or workflow role. The provisioning tool exits once installation, local identity delivery and initial Kubernetes admission are complete. [The DIY identity design](diy-identity-bootstrap.md) defines that split and the acceptance tests.

## Glossary and DIY replacements

This table describes the proposal. The current system still runs the components in the first column.

| Component | What it does here | DIY replacement or retained role |
| --- | --- | --- |
| Smee | Supplies proxy-DHCP/PXE behavior and per-machine iPXE scripts. | Existing DHCP plus a static signed-bootstrap boot path through iPXE or supported UEFI HTTP boot. No Smee. |
| HookOS | Runs the attester and installation actions in temporary Linux. | Our Alpine-based or comparable small RAM image, packaged and signed with our attester and fixed install routine. No upstream HookOS dependency is required. |
| Tink server, controller and agent | Deliver workflows and record action progress. | The bootstrap program's fixed sequence and the provisioning tool's attempt record. No Tink protocol or general job engine. |
| Rufio | Requests BMC power and boot operations. | Owner-run AMT/BMC commands or console operation. No Rufio controller. |
| Embedded Kubernetes API and etcd | Store Tinkerbell objects and workflow state. | No replacement cluster. Persist enrollment and install receipts with the provisioning tool. |
| fleetd | Combines enrollment, installation, lifecycle reconciliation and identity maintenance. | Reuse verifier/installer code in a provisioning-time tool; retain only a small separate identity service at runtime. No full fleetd daemon. |
| DevID CA | Signs certificates for device keys and attestation keys. | Retain the trusted issuer and protected signing key, available for enrollment and renewal. Never embed it in the bootstrap image. |
| LDevID and LAK | Certificates for the TPM device key and locally certified attestation key. | Retain both, with persistent TPM-wrapped key material and a tested renewal handoff. |
| SPIRE server | Admits agents and signs workload identity credentials. | Retain on spore, including registration and withdrawal handling. |
| SPIRE agent | Proves node identity and serves the local Workload API. | Retain on each workload node; require the LDevID path for these nodes. |
| NetBox | Records expected hardware, owner intent and lifecycle observations. | Retain inventory; the provisioning tool records outcomes and the identity service reads eligibility changes. |

## What this choice buys us

This is a credible simplification because the desired program has a narrow purpose: establish a TPM-backed identity, install an approved OS, and hand that identity to SPIRE. We can accept manual boot, attended retries and explicit retirement operations without sacrificing the identity chain. Those limits remove much of the need for a reusable provisioning orchestrator.

The cost shifts to maintaining the bootstrap image, the bounded install protocol and the handoff across reboot and renewal. We own driver coverage, image updates, trust-root rotation and failure recovery. The continuous identity service still holds sensitive issuance and withdrawal authority; reducing its scope does not make it unprivileged.

A direct Talos install without this enrollment path is a different option and does not meet the primary requirement by itself. It can remain an operational baseline, but a successful install is not the acceptance criterion. The proposed pilot must demonstrate a fresh SPIRE LDevID attestation and a workload SVID after the provisioning tool is shut down. It must also reject the wrong TPM, survive cold boot, renew the local identity package and withdraw access according to policy.

Keep the current stack until that pilot demonstrates the identity and recovery behavior. The reason to build the DIY stack is to own a small hardware-to-workload identity path, with attended provisioning as an explicit scope choice.

## Make EK enrollment easier

Reading an EK is already automated. HookOS discovers the keys, and `tink-attest inspect` can print a local TPM report without contacting fleetd. `mise run attest:approve <serial>` formats a waiting claim as candidate inventory entries. The missing convenience is a trusted receiving workflow that joins those observations to the machine in front of us.

The strongest practical improvement is to make receiving a single guided operation. A proposed receiving tool boots a trusted local image, collects the EKs and disk identity, and asks the owner to check the chassis label. It exports a report, perhaps with a QR code or short comparison digest, to an authenticated workstation that prepares the inventory pull request. The receiving report stays in private records; the pull request carries the required binding fields and an evidence reference. Atlantis remains the writer of the approved NetBox binding.

This removes hash transcription without relaxing admission. The independent observation comes from the receiving process and its trusted console or report transfer. A QR code generated from a remote pending claim alone adds no trust. Pending claims currently precede proof of TPM possession, so even calling one an attested machine would overstate the evidence.

A remote pairing flow could also collect possession and boot evidence while withholding credentials, then ask the owner to confirm a session-bound code on a trusted console. That requires a new enrollment-only protocol: the present verifier requires the approved binding before it challenges the TPM. The console confirmation must identify the exact candidate and key set, not whichever claim happens to be pending for that serial.

A constrained first-boot enrollment mode is another possible design. The owner opens a short enrollment window for one expected machine on an isolated receiving connection; the system requires a manufacturer-certified TPM, verifies possession, pins its EKs and closes enrollment. That is trust on first use: it accepts the risk that an attacker can substitute a machine during that window. Port checks, short expiry and owner confirmation reduce exposure but do not recreate independent chassis-to-key evidence. This policy is not implemented today.

Supplier-signed platform records can avoid a local scan when they bind the chassis identity to the TPM and we validate their issuer and contents. A TPM manufacturer's EK certificate alone is insufficient. The [TCG platform-certificate profile](https://www.trustedcomputinggroup.org/resources/documents/tcg-platform-certificate-profile) defines the richer relationship, but we cannot assume every purchased machine supplies it. AMT can help boot and view a receiving program, but this fleet has no implemented AMT API for reading an authenticated chassis-to-EK binding. Its current HTTP digest transport also needs review before treating remote console receiving as an independently protected channel.

The first improvement to make is automated receiving and PR preparation. Changing the enrollment trust policy should be a separate decision from removing Tinkerbell.

## Which security gaps matter to this decision

The controls make the most sense against two everyday risks: provisioning the wrong machine or disk, and letting an untrusted network client claim a legitimate machine's identity. Inventory checks, disk serial matching, approved EKs and fresh TPM evidence address those risks. Removing Tinkerbell while retaining those checks need not weaken that admission model.

There are also concrete gaps worth prioritizing. Tink authenticates its server to the agent, but the agent has no client credential and identifies itself by MAC. A client can forge progress or completion reports. fleetd corroborates retirement with AMT power state where available, but an off machine is not proof of an erased disk. An authenticated replacement executor could improve this; merely issuing the same work manually over AMT does not authenticate the disk result.

The boot policy accepts signing authorities without an exact-image version floor, so an older accepted signed image can pass. The install code becomes a bearer secret after TPM unwrapping, and acknowledging its delivery does not prove Talos persists the configuration. Power loss in that gap requires a new provision. These are separate image-policy and delivery issues; choosing a workflow engine does not resolve them.

Management-plane compromise is a broader limit. fleetd, the NetBox administrators and the Terraform credential can influence admission. NetBox's HTTP management path also needs trust. Shared age keys and vault access connect cluster administration to management secrets, so running spore outside folly provides recovery independence without complete security isolation. A YubiKey limits private-key extraction but cannot prevent a compromised authorized host from requesting signatures.

Finally, stopping new issuance does not end every existing session. A cordon leaves running workloads in place, issued SPIRE credentials need to expire, and a saved disk can retain a kubelet certificate. Withdrawal safeguards and other registration owners can delay removal too. Those limits require a credential and incident-response policy under either provisioning approach.

The [detailed threat model](folly-design.md#7-threat-model) maps these claims to source, and its [acceptance criteria](folly-design.md#8-failure-behavior-and-acceptance) distinguish tests from hardware evidence. The decision is whether the smaller bootstrap and identity services preserve the required TPM-to-workload chain with an acceptable amount of attended provisioning work.
