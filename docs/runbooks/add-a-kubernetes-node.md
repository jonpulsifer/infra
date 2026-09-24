---
title: Add a Kubernetes node
description: Declare a new x86_64 Kubernetes node and install it from the installer ISO.
---

Use this runbook to add an x86_64 node to the `folly` (on-site) or `offsite` (remote-site) cluster.

## Before you start

- Run `mise run devshell`.
- You need physical access to the host and a USB drive.
- You need SSH access to the host as `jawn`.
- `<build-host>` is `riptide.lolwtf.ca` for a `folly` node. For an `offsite` node, use another `offsite` node, such as `oldschool.lolwtf.ca`.

## Declare the node

1. Add an entry for the host to `nix/hosts/default.nix`. Set `tags` to `[ "folly" ]` or `[ "offsite" ]`.
2. Copy `nix/hosts/shale.nix` to `nix/hosts/<host>.nix`.
3. In the new file, set `homelab.disko.device` to the disk of the host.

> [!CAUTION]
> The host cannot decrypt its SOPS file until you add its age recipient after the first boot. Do not declare a secret that the host needs to boot.

4. If the host needs secrets, create its SOPS file with only the operator key, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
5. Run the flake checks.

   ```bash
   mise run nix:check
   ```

   Result: The command completes without an error.

6. Build the closure of the host.

   ```bash
   NIX_REMOTE=ssh-ng://<build-host> HOST=<host> mise run nix:build
   ```

   Result: The command prints the store path of the closure.

7. If the host has the `folly` tag, add it to `static_records` in `terraform/network/unifi/folly/k8s.tf`.
8. Open a pull request.
9. If the host has the `folly` tag, apply the Terraform change, as [Apply a Terraform change](apply-a-terraform-change.md) describes.

## Install the node

1. Build the installer ISO.

   ```bash
   nix build .#iso
   ```

   Result: `result/iso/` contains the ISO file.

2. Write the ISO file to the USB drive.
3. Boot the host from the USB drive.

> [!WARNING]
> `homelab-install` erases the disk in `homelab.disko.device` after you type the host name.

4. Run the install script. If the change is not on `main`, add `github:jonpulsifer/infra/<branch>` as the second argument.

   ```bash
   sudo homelab-install <host>
   ```

   Result: The script prints `>> Target disk:` and the disk, then asks for the host name.

5. Make sure that the target disk is the disk to erase.
6. Type the host name.

   Result: The script prints `>> Done. Reboot when ready:  sudo reboot`.

7. Reboot the host.
8. Make sure that no systemd unit failed.

   ```bash
   ssh <host>.lolwtf.ca systemctl --failed --no-pager
   ```

   Result: The command prints `0 loaded units listed.`

9. If the host needs secrets, add its age recipient, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
10. Join the node to the cluster with `nixos-kubernetes-node-join`, so that it gets its Kubernetes certificates.
11. Give the node a BGP session, as the rules in [Routing and firewall](../platform/network/routing-and-firewall.md#rules) describe.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `homelab-install` prints `Could not read homelab.disko.device`. | The host configuration does not evaluate, or it does not import `../profiles/k8s-node.nix`. | Type any text other than the host name to stop the script. Correct the host file. |
| A systemd unit failed. | The configuration broke the unit. | Run `ssh <host>.lolwtf.ca journalctl -u <unit> -n 80 --no-pager`. |

## Related

- [Deploy a NixOS host](deploy-a-nixos-host.md): deploy a later change to the node.
- [Manage SOPS secrets](manage-sops-secrets.md): the two-stage recipient setup.
- [NixOS](../platform/nixos.md): the host registry.
