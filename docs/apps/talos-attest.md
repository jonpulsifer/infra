---
title: talos-attest
description: A Go service on the anchors that attests a folly machine's TPM and boot chain from HookOS, and issues the TPM an LDevID and a LAK certificate from the DevID CA.
status: unverified
---

talos-attest checks which TPM a machine has and what it booted, before the machine gets a Talos config. A machine that passes gets an LDevID, a signing key that stays in its TPM with a certificate from the DevID CA, and a LAK, the attestation key's certificate. SPIRE's `tpm_devid` attestor and talos-enroll's auto-approve read the result. The Tinkerbell action `tink-attest` drives it from HookOS. No machine has attested through the anchors yet.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Device flow | `http://<BOOT_VIP>/attest/v1/attest` and the session routes under it | The bootstrap VLAN, through the boot VIP's nginx |
| LDevID and verdict lookups | `http://<anchor>:8444/devid/<serial>` and `/verdict/<serial>` | folly's `K8S_NODE_CIDR` and `CILIUM_POD_CIDR`, on the anchor network |
| Admin API | `https://<anchor>.<tailnet>:8445`, `GET /machines` and `POST /approve` | Tailnet logins in `ATTEST_APPROVERS` |

`BOOT_VIP` is in `clusters/folly/config/anchor-topology.json`. [Attest a node](../runbooks/attest-a-node.md) is the procedure.

## Limits

- Each anchor keeps the attestations it ran in `/var/lib/talos-attest`. A lookup asks the other anchors, and the newest verdict wins.
- A first intake needs the owner's approval on the anchor that ran it, unless `machines.yaml` or NetBox's `ek_hash` pins the EK.
- `policy.yaml` pins no Authenticode hashes. The DevID CA key is a software key from `terraform/pki`, until an anchor sets `homelab.talosAttest.caKey = "pkcs11"` and signs with its YubiKey.
- A TPM with no RSA EK certificate attests here, but SPIRE's `tpm_devid` cannot use it. `rsa_ek_cert` in the answers says which.

## How it works

The action sends the machine's serial, MAC and EK certificates, and a new AK. The service checks each EK certificate against `apps/talos-attest/roots/`, refuses a ROCA-weak RSA EK, and matches the inventory. It sends one credential challenge per EK. The action answers them, quotes PCRs 0 to 7 with the nonce, sends the event log, and certifies a new LDevID key with the AK. The service replays the log against `policy.yaml`: Secure Boot on, the lab's PK, and only the lab's two signing keys verify a boot application. It then issues both certificates. The action stores them in NV `0x01c90000` and `0x01c90001`. Every key is a child of the TCG H-2 storage key, which the TPM derives again on demand, so the TPM keeps no key. A refusal quarantines the machine and withdraws its LDevID.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `TalosAttestQuarantined` | A machine's newest verdict is a refusal | [Attest a node](../runbooks/attest-a-node.md) |
| `TalosAttestWaitingForApproval` | A first intake waits for the owner | [Attest a node](../runbooks/attest-a-node.md) |
| `TalosAttestNotServing` | An anchor's talos-attest does not answer | [Attest a node](../runbooks/attest-a-node.md) |
| `TalosAttestLDevIDExpiring` | An LDevID expires within 30 days | [Attest a node](../runbooks/attest-a-node.md) |

## Reference

- Source, HTTP contract and Nix package: `apps/talos-attest/`
- Anchors: `nix/services/talos-attest.nix`
- Template: `clusters/folly/tinkerbell/template-attest.yaml`
- Alerts: `clusters/folly/monitoring/anchor-vips.yaml`
- DevID CAs: `terraform/pki/devid.tf` and `terraform/pki/devid-ca.tf`
- Token signer: `packages/pkcs11signer`
- Image: `ghcr.io/jonpulsifer/tink-attest`
