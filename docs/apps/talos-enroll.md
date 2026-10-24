---
title: Talos enrollment
description: A Go service on the folly cluster that answers the OAuth device flow of a Talos machine booted from the network, and releases the machine's config once the owner approves it.
status: unverified
---

talos-enroll is the enrollment server for folly's Talos nodes. A machine that boots the signed Talos image over UEFI HTTP boot asks it for a device code, waits for the owner's approval, and then fetches its machine config. No machine has enrolled through it yet.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Device flow | `https://enroll.lolwtf.ca`, paths `/device/code`, `/token` and `/config` | Clients that route to `ENROLL_VIP`, the bootstrap VLAN included |
| Approval page and API | `https://talos-enroll.<tailnet>` | Tailnet logins in `ENROLL_APPROVERS` |
| Prompts | The Discord channel of the Alertmanager webhook | Members of that channel |

Each machine gets one Discord message, which the server edits as its enrollment moves on. `mise run enroll:approve <code> <node>`, `enroll:deny` and `enroll:pending` call the approval API. [Enroll a Talos node](../runbooks/enroll-a-talos-node.md) is the procedure.

## Limits

- A device code lasts 15 minutes and a token 30 minutes. A token releases one config.
- State is in memory. A restart forgets every enrollment and denial, and Talos starts a new device flow.
- The machine's UUID, MAC, serial and hostname are unverified claims. The token is bound to the UUID.
- A node whose installer image comes from the Image Factory resource is unknown without state, so `machine-inputs.json` leaves it out.

## How it works

The HTTP boot UKI carries `talos.config` and the `talos.config.oauth.*` arguments, with client `talos-enroll`. On approval, the server renders the node's config with `talosctl gen config --with-secrets`, the 1Password note `talos-folly-secrets` and the node's entry in `clusters/folly/apps/talos-enroll/machine-inputs.json`, as the `clusters/folly/talos/` root does. The token exists only once the config renders. `mise run render-machine-inputs` writes that file from the root's `machine_inputs` output with `tofu console` and no state.

The Gateway serves the device flow at `ENROLL_VIP` in `clusters/folly/config/cluster-topology.json` with a Let's Encrypt certificate, because Talos trusts only its bundled roots before it has a config. The approval listener trusts `Tailscale-User-Login`, and its NetworkPolicy admits only the tailnet Ingress proxy.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `TalosEnrollmentWaiting` | A machine has waited 30 minutes for approval | [Enroll a Talos node](../runbooks/enroll-a-talos-node.md) |
| `TalosEnrollmentConfigNotFetched` | An approved machine has fetched no config for 10 minutes | [Enroll a Talos node](../runbooks/enroll-a-talos-node.md) |
| `TalosEnrolledNodeNotReady` | A node fetched its config 30 minutes ago and is not Ready | [Enroll a Talos node](../runbooks/enroll-a-talos-node.md) |

After a change to `clusters/folly/talos/`, run `mise run render-machine-inputs` and commit both files in the same pull request.

## Reference

- Source and HTTP contract: `apps/talos-enroll/`
- Manifests: `clusters/folly/apps/talos-enroll/`
- Alerts: `clusters/folly/monitoring/talos-enroll-rules.yaml`
- Image: `ghcr.io/jonpulsifer/talos-enroll`
