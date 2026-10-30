---
title: talos-attest
description: A Go service on the anchors that attests a folly machine's TPM and boot chain from HookOS, and issues the TPM an LDevID and a LAK certificate from the DevID CA.
status: live
---

talos-attest checks which TPM a machine has and what it booted, before the machine gets a Talos config. A machine that passes gets an LDevID, a signing key that stays in its TPM with a certificate from the DevID CA, and a LAK, the attestation key's certificate. SPIRE's `tpm_devid` attestor reads the result, and the install code it answers lets the node fetch its Talos config. The Tinkerbell action `tink-attest` drives it from HookOS. NetBox is its system of record: the device with the machine's serial names it, gives it its class and lifecycle status, and holds every verdict.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Device flow | `http://<BOOT_VIP>/attest/v1/attest` and the session routes under it | The bootstrap VLAN, through the boot VIP's nginx |
| LDevID and verdict lookups, and renewal | `http://<anchor>:8444/devid/<serial>`, `/verdict/<serial>`, `POST /v1/renew` | folly's `K8S_NODE_CIDR` and `CILIUM_POD_CIDR`, on the anchor network |
| Admin API | `https://<anchor>.<tailnet>:8445`, `GET /machines`, `POST /approve`, `GET /intake` and `POST /intake` | Tailnet logins in `ATTEST_APPROVERS` |

`BOOT_VIP` is in `clusters/folly/config/anchor-topology.json`. [Provision a node](../runbooks/provision-a-node.md) is the procedure, and `mise run attest:approve <serial>` approves a first intake. A box whose serial the owner entered in NetBox as a `planned` device, with its name and class, passes on its own. `mise run fleet:intake open 2h` opens the intake window on every anchor, `fleet:intake close` closes it and `fleet:intake status` shows it.

## Limits

- NetBox has the last word on a verdict. Each anchor keeps the certificates and key blobs it issued in `/var/lib/talos-attest`, and a lookup asks the other anchors for them. Without `ATTEST_NETBOX_URL`, the anchors' newest verdict decides and `machines.yaml` names the machines.
- A first intake needs the owner's approval on the anchor that ran it, unless NetBox's `ek_hash` or `machines.yaml` pins the EK, or every EK carries a manufacturer certificate and the device is `planned`, or the serial is unknown and the intake window is open under the `open` policy.
- Under the `open` policy, within the window, any box with a genuine TPM from a maker in `roots/` that boots the lab-signed HookOS on the bootstrap VLAN becomes a `staged` device: the window is the owner's statement of physical presence. The default `declared` policy admits only the serials the owner entered in NetBox.
- A declared `planned` box can be impersonated before it attests. The lab's Secure Boot `.auth` files are public, so a TPM from a pinned maker in a box with a rewritten SMBIOS serial and a spoofed MAC, on an open bootstrap port, can take the stub's identity first. The MAC is a tripwire, not authentication. Keep the gap between declaring and plugging in short; in a data centre set `homelab.talosAttest.intakeRequireWindow` and give stubs an `expected_port`; pin the EK hashes where a vendor supplies them.
- `policy.yaml` pins no Authenticode hashes. The DevID CA key is a software key from `terraform/pki`, until an anchor sets `homelab.talosAttest.caKey = "pkcs11"` and signs with its YubiKey.
- A TPM with no RSA EK certificate attests here, but SPIRE's `tpm_devid` cannot use it. `rsa_ek_cert` in the answers says which.
- A renewal certifies the LDevID key on file again. A new key takes an intake from HookOS.
- The daily check applies the renewal policy: Secure Boot, the lab's PK and lab-signed boot applications. `renew_required_authorities` is empty, so no one signing key is required.

## How it works

The action sends the machine's serial, MAC, SMBIOS model and EK certificates, and a new AK. The service finds the NetBox device with that serial. A serial NetBox has never seen gets a device at `staged` once its TPM activates a credential, named by the claimed hostname or `intake-<serial>`, under the device type the model names. A device in `failed`, `decommissioning` or `offline` is refused, and only the owner moves it out of those; a retired device has no verdict or LDevID to serve. The service checks each EK certificate against `apps/talos-attest/roots/`, refuses a ROCA-weak RSA EK, and matches the MAC and the EK pins. It sends one credential challenge per EK. The action answers them, quotes PCRs 0 to 7 with the nonce, sends the event log, and certifies a new LDevID key with the AK. The service replays the log against `policy.yaml`: Secure Boot on, the lab's PK, and only the lab's two signing keys verify a boot application. It then issues both certificates, with the subject `CN=<name>, serialNumber=<serial>, OU=<talos_class>, O=<site>`, for 90 days. The action stores them in NV `0x01c90000` and `0x01c90001`. Every key is a child of the TCG H-2 storage key, which the TPM derives again on demand, so the TPM keeps no key.

Only a check the machine's TPM signed for becomes a verdict: the boot evidence after credential activation at intake, after the LAK's signature on a renewal, and after the LAK's signature and its certification of the LDevID key on file in a daily check. A quarantine withdraws the LDevID and sets the device `failed`. Anything refused before that proof, a wrong MAC, an unknown EK, a failed activation, a quote the LAK did not sign, a retired or failed device, is answered `refused`, counted and audited, and changes no record: serials are public, and nobody withdraws a node's identity by knowing one. When NetBox does not answer, every request is refused and nothing is created or pinned; a `planned` device skips approval only on NetBox's word, and until its quote verifies a failure refuses rather than quarantines.

An answer from another anchor arrives over plain HTTP, so nothing in it is used until its certificates verify against the DevID CA and name the machine, and its key blobs are the keys they certify. Hashes a peer reports never become pins: only a session that activated a credential on the EKs writes them.

Each verdict goes to the device before the machine gets its answer: `attest_verdict`, `last_attested`, the certificate serials and, on a pass, the EK pins and the SMBIOS facts, `smbios_uuid` among them once `scripts/netbox-seed.sh` has defined that field. An intake pass also writes where the machine is plugged in, as the session's AK signed it: `attested_address`, `attested_switch`, `attested_switch_port` and `attested_network_at`, each once NetBox defines it. `tink-attest` reads them in the host's network namespace, the boot NIC's IPv4 address and the switch's LLDP frame within 35 seconds; facts without a good signature are dropped, and the pass stands. The address must also be the one the evidence came from, which the anchor's nginx passes in `X-Real-IP` (`nix/services/talos-attest.nix`); another is dropped with a journal entry, and the port stays. A pass or a wait on a `planned` device stages it. The service writes `status` for nothing else: fleet-controller sets `active` when the node fetches its config. When the write fails, the anchors' own verdict stands, and a quarantine among them beats a stale pass in NetBox.

A first intake's claim waits apart from the machine records, keyed by its serial, until the owner approves its hashes by name; it writes and replaces no identity, and NetBox hears of it only when the device has no pass. A serial NetBox has never seen gets no device for a claim: the device is created once the machine's TPM activates a credential, at most ten new EKs an hour.

`homelab.talosAttest.intakePolicy` in `nix/services/talos-attest.nix` sets `ATTEST_INTAKE_POLICY`, how a box with no pins on record gets its identity:

| Policy | Rule |
| --- | --- |
| `declared`, the default | The owner's stub is the authorization: a `planned` device NetBox holds with the claimed serial passes when every EK certificate chains to `roots/`, window or not, or only while the window is open with `homelab.talosAttest.intakeRequireWindow`, the data-centre setting. The pass binds the stub to the box: just before issuing, the service looks the stub up again and refuses when it has left `planned`, holds another MAC or holds other pins, then puts the claimed MAC on its interface and refuses unless that is the interface's one MAC. The device keeps its name, the first box to bind a stub holds it, and every planned device needs a claimed MAC that reads as one. A serial NetBox does not know stays pending, window or not. |
| `open`, the opt-in | Within the intake window, a serial neither NetBox nor `machines.yaml` knows, whose every EK certificate chains to `roots/`, is treated as a `planned` device: no approval, then activation, quote, policy and LDevID as usual. The pass creates the device at `staged`, named `intake-<serial>`, with the first-sight facts and the EK hashes as its pins. Outside the window its claim is pending. A planned device passes by the planned rule and is not bound; one with no pins is still looked up again before issuing. |

The intake window is the owner's statement that a batch of boxes is being racked. `ATTEST_INTAKE_WINDOW_FILE`, `/var/lib/talos-attest/intake-open`, holds an RFC3339 close time, at most 24 hours after it was written or after now, whichever is earlier; `scripts/fleet-intake.sh` writes it on every anchor over ssh, `POST /intake` writes it on one, and the service reads it on every start, so neither needs a restart. A later close time is clamped and journaled. Under either policy an EK without a maker's certificate leaves the claim pending, and nothing changes the outcome for a serial NetBox knows: a pin mismatch, a `failed` device and a known device with no pin decide as before, and a device NetBox learns of during a session is held to the same rules and must be `planned` or `staged`. A pass never replaces an EK pin on file. Each intake pass writes an `attest.intake` audit line. `talos_attest_intake_open` and `talos_attest_intake_open_until_seconds`, labelled with the policy, report the window; under `declared` without `intakeRequireWindow` the window decides nothing and reports closed.

Every ten minutes each anchor adopts the newest pass its peers hold for the machines it knows, such as a renewal served elsewhere, once the pass verifies against the DevID CA and its timestamps are no further than five minutes ahead. Newest means the LDevID's issue time, which the CA signed, never the peer's clock: a replay of an older pass changes nothing and never undoes an anchor's own quarantine. A peer's word gates nothing: a quarantine is never taken from one, since the anchor that produced it wrote it to NetBox. At most fifty first-intake claims wait at once; the oldest give way.

From the running node, a renewal asks `POST /v1/renew` for a nonce, quotes with the LAK, certifies the LDevID key on file with it, and sends the running boot's event log. The policy's `renew_required_authorities` governs that boot in place of `required_authorities`, since a running node boots the Talos UKI, not HookOS. Both certificates roll. A device that stops renewing loses its identity at expiry, which is the revocation.

On every other day the node sends the daily check: the same routes with `check` set, the same evidence, and the BIOS version it reads from SMBIOS. The service judges the boot by the renewal policy and issues nothing. Before any write, the LAK must sign the quote over the session's nonce and certify the LDevID key on file with it, so forged, replayed or foreign evidence is `refused` and records nothing. After that proof, a boot that misses the policy, or an event log that does not replay to the quoted PCRs, quarantines the device. A node whose `talos_class` is `controlplane` is never quarantined by a check or a renewal, since `failed` would move the cluster's API to the bootstrap VLAN: its `attest_verdict` reads `failed-no-quarantine: <reason>`, the device is journaled, `TalosAttestCheckFailed` fires at critical until a passing quote, and its status and LDevID stay. A pass writes only `attest_verdict` and `last_attested`. A transport error, a timeout or a missing TPM proves nothing and never quarantines; `TalosAttestNotChecked` reports it. Since a check moves `last_attested` without issuing, the anchors match a verdict to the LDevID they serve by `ldevid_serial`. A service that predates the check leaves `check` out of its answer, and the client sends it no evidence.

Each passing quote from the running node, check or renewal, records PCR 0 under the reported BIOS version in the device's `pcr0_by_bios` JSON field, which `scripts/netbox-seed.sh` defines, and refreshes `bios_version`. A new version adds an entry. A different PCR 0 at a version on file stays unwritten: the service journals both values on the device, audits `attest.pcr0`, sets `talos_attest_pcr0_changed`, and never quarantines. The owner explains the change by editing the entry, and the next check clears the alert. The BIOS version is the node's claim, used only after the TPM's proof; a new version always shows in the device journal.

The device flow is plain HTTP, so the confirm carries the session's AK signature over its nonce. A forged signature is refused and leaves the session open, and only a signed confirm gets an install code; an unsigned confirm, from a `tink-attest` that predates the signature, confirms the pass without one. With `FLEET_RENDER_URL` set, the confirm of an intake pass then answers an install code, 32 random bytes as base64url, the bearer name of the machine's rendered Talos config. The service posts `{serial, uuid, node, class, code}` to fleet-controller's `/render` on spore over the anchor network, signed in `X-Fleet-Signature` with HMAC-SHA512 over the body, and only once the claimed SMBIOS UUID reads as one. On the controller's 201, once the config file exists, it answers the code wrapped to the machine's TPM with TPM2_MakeCredential against the session's EK and AK, so only that TPM reads it. Any other answer leaves the code out and audits the status; the pass stands. A renewal mints no code. `tink-attest` unwraps the code with its AK, writes it to `/tmp/fleet/install_code`, mode 0600, for the Workflow's later actions, and never logs it. `nix/services/talos-attest.nix` sets `FLEET_RENDER_URL` on an anchor whose sops file holds `fleet-controller/attest-secret`, which every anchor's does. When the controller refuses or does not answer, the confirm withholds the code and one `attest.install` audit line gives the status; the pass stands.

Every decision is one JSON line on stdout with `event` set to `attest.verdict`, `attest.issue`, `attest.renew`, `attest.check`, `attest.pcr0`, `attest.install` or `attest.intake`, and the site, node, serial, class, status, approver and reason.

On a running node, `tink-attest renew` in the DaemonSet `tpm-reattest` runs daily. It renews the LDevID from 30 days before its expiry and otherwise sends the daily check, with a quote that the LAK signs, through `POST /v1/renew` and `POST /v1/renew/{session}/evidence` on the DevID listener. [Identity](../platform/identity.md#renewal) has the steps.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `TalosAttestQuarantined` | A machine's newest verdict is a refusal | [Provision a node](../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `TalosAttestWaitingForApproval` | A first intake waits for the owner | [Provision a node](../runbooks/provision-a-node.md#approve-a-first-intake) |
| `TalosAttestNotServing` | An anchor's talos-attest does not answer | [Provision a node](../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `TalosAttestIntakeOpen` | An anchor's intake window has been open for 6 hours | `mise run fleet:intake close` |
| `TalosAttestLDevIDExpiring` | An LDevID expires within 23 days, after a week of failed renewals | [Add a TPM node to SPIRE](../runbooks/add-a-tpm-node-to-spire.md#if-something-goes-wrong) |
| `TalosAttestNotChecked` | No anchor has recorded a passing quote from a node for 26 hours | [Add a TPM node to SPIRE](../runbooks/add-a-tpm-node-to-spire.md#if-something-goes-wrong) |
| `TalosAttestCheckFailed` | A daily check ended in a quarantine, or in a refusal before the TPM's proof; critical when a control-plane node failed and stays in place | [Provision a node](../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `TalosAttestPCR0Changed` | A node's PCR 0 differs from the one NetBox holds for its BIOS version | Read the device's NetBox journal, then edit `pcr0_by_bios` once the change is explained |

## Reference

- Source, HTTP contract and Nix package: `apps/talos-attest/`
- Anchors: `nix/services/talos-attest.nix`
- Template: the `attest` action of `clusters/folly/tinkerbell/template.yaml`
- Renewal: `clusters/folly/apps/spire/tpm-reattest.yaml`
- Alerts: `clusters/folly/monitoring/anchor-vips.yaml`
- DevID CAs: `terraform/pki/devid.tf` and `terraform/pki/devid-ca.tf`
- Token signer: `packages/pkcs11signer`
- Image: `ghcr.io/jonpulsifer/tink-attest`
