---
title: Keylime
description: The remote attestation verifier for folly's running nodes, being introduced beside fleetd's own check.
status: experiment
---

Keylime is the verifier that judges a running folly node's boot. It is being introduced in stages. Today the repo holds its boot policy; fleetd's hourly check still decides, as [Identity](../platform/identity.md#renewal) describes. fleetd keeps intake, the LDevID and LAK, the NetBox lifecycle and the consequences of a failed boot.

## How it works

Keylime's verifier replays a node's UEFI event log against the quoted PCRs, then asks a measured-boot policy whether the boot is acceptable. The policy here is `fleetd-profile`, in `apps/keylime-policy/lolwtf_mb_policy.py`. It reads the same profile fleetd reads, `apps/fleetd/attest/policy/<name>.yaml`, rendered to JSON by `apps/fleetd/cmd/keylime-policy-render` into `clusters/folly/apps/keylime/policies/`, and makes the same checks in the same words as `Policy.evaluate` in `apps/fleetd/attest/policy.go`: the platform key, the key exchange keys, the required and allowed db entries, the authorities before and after the separator, and the pinned boot applications.

`mise run keylime:render-policies` writes the reference states. A Go test fails when a committed file differs from a fresh render. `apps/keylime-policy/testdata/cases.json` names the verdicts both verifiers must give riptide's boot, and `mise run keylime:test` and the Go tests in `apps/fleetd/attest/` both assert every case.

## Limits

- Talos's kernel has no IMA, so the evidence is PCRs 0 to 7 and the event log. There is no runtime file integrity.
- The policy judges the running node. Intake, which requires the HookOS signing authority, stays fleetd's.

## Reference

- Policy: `apps/keylime-policy/`
- Renderer: `apps/fleetd/cmd/keylime-policy-render/`
- Reference states: `clusters/folly/apps/keylime/policies/`
