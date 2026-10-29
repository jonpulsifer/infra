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
| Admin API | `https://<anchor>.<tailnet>:8445`, `GET /machines` and `POST /approve` | Tailnet logins in `ATTEST_APPROVERS` |

`BOOT_VIP` is in `clusters/folly/config/anchor-topology.json`. [Provision a node](../runbooks/provision-a-node.md) is the procedure, and `mise run attest:approve <serial>` approves a first intake.

## Limits

- NetBox has the last word on a verdict. Each anchor keeps the certificates and key blobs it issued in `/var/lib/talos-attest`, and a lookup asks the other anchors for them. Without `ATTEST_NETBOX_URL`, the anchors' newest verdict decides and `machines.yaml` names the machines.
- A first intake needs the owner's approval on the anchor that ran it, unless NetBox's `ek_hash` or `machines.yaml` pins the EK, or the device is `planned` and every EK carries a manufacturer certificate.
- `policy.yaml` pins no Authenticode hashes. The DevID CA key is a software key from `terraform/pki`, until an anchor sets `homelab.talosAttest.caKey = "pkcs11"` and signs with its YubiKey.
- A TPM with no RSA EK certificate attests here, but SPIRE's `tpm_devid` cannot use it. `rsa_ek_cert` in the answers says which.
- A renewal certifies the LDevID key on file again. A new key takes an intake from HookOS.

## How it works

The action sends the machine's serial, MAC, SMBIOS model and EK certificates, and a new AK. The service finds the NetBox device with that serial. A serial NetBox has never seen gets a device at `staged` once its TPM activates a credential, named by the claimed hostname or `intake-<serial>`, under the device type the model names. A device in `failed`, `decommissioning` or `offline` is refused, and only the owner moves it out of those; a retired device has no verdict or LDevID to serve. The service checks each EK certificate against `apps/talos-attest/roots/`, refuses a ROCA-weak RSA EK, and matches the MAC and the EK pins. It sends one credential challenge per EK. The action answers them, quotes PCRs 0 to 7 with the nonce, sends the event log, and certifies a new LDevID key with the AK. The service replays the log against `policy.yaml`: Secure Boot on, the lab's PK, and only the lab's two signing keys verify a boot application. It then issues both certificates, with the subject `CN=<name>, serialNumber=<serial>, OU=<talos_class>, O=<site>`, for 90 days. The action stores them in NV `0x01c90000` and `0x01c90001`. Every key is a child of the TCG H-2 storage key, which the TPM derives again on demand, so the TPM keeps no key.

Only a check the machine's TPM signed for becomes a verdict: the boot evidence after credential activation at intake, and after the LAK's signature on a renewal. A quarantine withdraws the LDevID and sets the device `failed`. Anything refused before that proof, a wrong MAC, an unknown EK, a failed activation, a quote the LAK did not sign, a retired or failed device, is answered `refused`, counted and audited, and changes no record: serials are public, and nobody withdraws a node's identity by knowing one. When NetBox does not answer, every request is refused and nothing is created or pinned; a `planned` device skips approval only on NetBox's word, and until its quote verifies a failure refuses rather than quarantines.

An answer from another anchor arrives over plain HTTP, so nothing in it is used until its certificates verify against the DevID CA and name the machine, and its key blobs are the keys they certify. Hashes a peer reports never become pins: only a session that activated a credential on the EKs writes them.

Each verdict goes to the device before the machine gets its answer: `attest_verdict`, `last_attested`, the certificate serials and, on a pass, the EK pins and the SMBIOS facts, `smbios_uuid` among them once `scripts/netbox-seed.sh` has defined that field. A pass or a wait on a `planned` device stages it. The service writes `status` for nothing else: fleet-controller sets `active` when the node fetches its config. When the write fails, the anchors' own verdict stands, and a quarantine among them beats a stale pass in NetBox.

A first intake's claim waits apart from the machine records, keyed by its serial, until the owner approves its hashes by name; it writes and replaces no identity, and NetBox hears of it only when the device has no pass. A serial NetBox has never seen gets no device for a claim: the device is created once the machine's TPM activates a credential, at most ten new EKs an hour.

Every ten minutes each anchor adopts the newest pass its peers hold for the machines it knows, such as a renewal served elsewhere, once the pass verifies against the DevID CA and its timestamps are no further than five minutes ahead. Newest means the LDevID's issue time, which the CA signed, never the peer's clock: a replay of an older pass changes nothing and never undoes an anchor's own quarantine. A peer's word gates nothing: a quarantine is never taken from one, since the anchor that produced it wrote it to NetBox. At most fifty first-intake claims wait at once; the oldest give way.

From the running node, a renewal asks `POST /v1/renew` for a nonce, quotes with the LAK, certifies the LDevID key on file with it, and sends the running boot's event log. The policy's `renew_required_authorities` governs that boot in place of `required_authorities`, since a running node boots the Talos UKI, not HookOS. Both certificates roll. A device that stops renewing loses its identity at expiry, which is the revocation.

The device flow is plain HTTP, so the confirm carries the session's AK signature over its nonce. A forged signature is refused and leaves the session open, and only a signed confirm gets an install code; an unsigned confirm, from a `tink-attest` that predates the signature, confirms the pass without one. With `FLEET_RENDER_URL` set, the confirm of an intake pass then answers an install code, 32 random bytes as base64url, the bearer name of the machine's rendered Talos config. The service posts `{serial, uuid, node, class, code}` to fleet-controller's `/render` on spore over the anchor network, signed in `X-Fleet-Signature` with HMAC-SHA512 over the body, and only once the claimed SMBIOS UUID reads as one. On the controller's 201, once the config file exists, it answers the code wrapped to the machine's TPM with TPM2_MakeCredential against the session's EK and AK, so only that TPM reads it. Any other answer leaves the code out and audits the status; the pass stands. A renewal mints no code. `tink-attest` unwraps the code with its AK, writes it to `/tmp/fleet/install_code`, mode 0600, for the Workflow's later actions, and never logs it. `nix/services/talos-attest.nix` sets `FLEET_RENDER_URL` on an anchor whose sops file holds `fleet-controller/attest-secret`, which every anchor's does. When the controller refuses or does not answer, the confirm withholds the code and one `attest.install` audit line gives the status; the pass stands.

Every decision is one JSON line on stdout with `event` set to `attest.verdict`, `attest.issue`, `attest.renew` or `attest.install`, and the site, node, serial, class, status, approver and reason.

On a running node, `tink-attest renew` in the DaemonSet `tpm-reattest` renews the LDevID from 30 days before its expiry, with a quote that the LAK signs, through `POST /v1/renew` and `POST /v1/renew/{session}/evidence` on the DevID listener. [Identity](../platform/identity.md#renewal) has the steps.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `TalosAttestQuarantined` | A machine's newest verdict is a refusal | [Provision a node](../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `TalosAttestWaitingForApproval` | A first intake waits for the owner | [Provision a node](../runbooks/provision-a-node.md#approve-a-first-intake) |
| `TalosAttestNotServing` | An anchor's talos-attest does not answer | [Provision a node](../runbooks/provision-a-node.md#if-something-goes-wrong) |
| `TalosAttestLDevIDExpiring` | An LDevID expires within 23 days, after a week of failed renewals | [Add a TPM node to SPIRE](../runbooks/add-a-tpm-node-to-spire.md#if-something-goes-wrong) |

## Reference

- Source, HTTP contract and Nix package: `apps/talos-attest/`
- Anchors: `nix/services/talos-attest.nix`
- Template: the `attest` action of `clusters/folly/tinkerbell/template.yaml`
- Renewal: `clusters/folly/apps/spire/tpm-reattest.yaml`
- Alerts: `clusters/folly/monitoring/anchor-vips.yaml`
- DevID CAs: `terraform/pki/devid.tf` and `terraform/pki/devid-ca.tf`
- Token signer: `packages/pkcs11signer`
- Image: `ghcr.io/jonpulsifer/tink-attest`
