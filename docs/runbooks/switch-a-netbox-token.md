---
title: Switch a NetBox token to its own user
description: Mint a v2 token for the terraform and fleetd NetBox users, move Terraform and fleetd onto them, and revoke the admin tokens.
---

Use this runbook after Atlantis applies `terraform/netbox/folly` with the `terraform` and `fleetd` users, and again to rotate either token. [NetBox](../platform/netbox.md#users-and-tokens) says what each user may do.

> [!WARNING]
> This runbook changes live state by hand. It is an exception to the GitOps rule because git cannot hold a token and the owner mints it in the UI.

## Before you start

- Atlantis has applied the pull request that declares the users, so `terraform` and `fleetd` exist in NetBox.
- `mise run devshell`, `op` signed in, and `SOPS_AGE_KEY_FILE` set as [Manage SOPS secrets](manage-sops-secrets.md#before-you-start) says.
- Until the `terraform` token is switched, Terraform's writes record as `admin` and fleetd counts no approved EK binding, so a planned machine waits.

## Switch the tokens

1. Open `https://capsule.<tailnet>` and sign in as `admin`.
2. Open Admin, then Users, then `terraform`, and add a token. Choose a v2 token, turn on Write enabled, and copy the value when NetBox shows it once. It starts with `nbt_`.
3. In 1Password, open the item `netbox-folly-terraform` in the `homelab` vault, replace its `credential` field with the new token, and save.
4. Make sure that the root reads the token as `terraform`. Comment `atlantis plan -d terraform/netbox/folly` on any pull request that touches the root, or run the plan locally.

   Result: The plan finishes with no authentication or permission error. A `403` names a permission that `terraform` lacks; add its object type to `terraform/netbox/folly/users.tf`.

5. Add a v2 token for `fleetd` the same way, with Write enabled.
6. Put it in spore's SOPS file, under `netbox-token` in the `fleetd` map, without printing it.

   ```bash
   sops nix/secrets/spore.sops.yaml
   ```

   In the editor, replace the value and save.

7. Deploy spore with [Deploy a NixOS host](deploy-a-nixos-host.md) from `main`, once the pull request that sets `homelab.fleetd.bindingAuthor` is merged.
8. Make sure that fleetd works with its token.

   ```bash
   ssh spore.<tailnet> systemctl is-active fleetd
   ```

   Result: `active`.

9. Revoke the old tokens. In Admin, then API Tokens, delete the `admin` token named "terraform: netbox/folly root through Atlantis". Keep the "automation: seed, export and drift" token for the scripts, and the `netbox/api-token` that `nix/secrets/capsule.sops.yaml` holds.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| A plan fails with `403` or `Invalid token`. | The token is a v1 token, is not write enabled, or belongs to another user. | Mint it again on `terraform` as a write-enabled v2 token. |
| fleetd journals `ek-binding-unauthored` for a device. | The binding's newest change is by `admin`, written before the switch. | Change the node's entry in `clusters/folly/inventory/nodes.yaml` through a pull request so Terraform writes the binding as `terraform`. |
| fleetd answers every request with a NetBox error. | The `fleetd` token is wrong or lacks a permission. | Mint it again, or add the object type to `terraform/netbox/folly/users.tf`. |

## Related

- [NetBox](../platform/netbox.md): the users, the tokens and the changelog check.
- [Manage SOPS secrets](manage-sops-secrets.md): edit spore's SOPS file.
- [Deploy a NixOS host](deploy-a-nixos-host.md): deploy spore.
