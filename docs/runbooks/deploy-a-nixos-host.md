---
title: Deploy a NixOS host
description: Deploy the NixOS configuration of a host from your machine or from GitHub Actions, restore the previous generation, or add a Kubernetes node.
---

Use this runbook to deploy a host's NixOS configuration before the daily auto-upgrade, to restore the previous generation, or to add a Kubernetes node. `nixos-rebuild` is the declared apply path for NixOS, as [How changes ship](../platform/how-changes-ship.md) describes. A generation is one built configuration of a host. The boot menu keeps the earlier generations until `nix.gc` in `nix/system/nixos.nix` deletes them, after 30 days by default.

## Before you start

- Run `mise run devshell`. The shell contains `nixos-rebuild`.
- You need SSH access to the host as `jawn`.
- Read the [host sheet](../hosts/index.md) of the host. It lists how to reach the host and its quirks.
- To restore a host that does not boot, you need console access to it.
- To add a node, you need physical access to it and a USB drive.
- To deploy from GitHub Actions, sign in to `gh` with permission to run workflows in `jonpulsifer/infra`.

`<host>` is the name of the host in `nix/hosts/default.nix`. Its tag is the `tags` value of that entry. The `folly` tag puts a node in the on-site cluster, and the `offsite` tag puts it in the remote-site cluster. An entry with a `kind` of `image` or `package` is not a host.

Find `<target>` and `<build-host>` for the host.

| Host | `<target>` | `<build-host>` |
| --- | --- | --- |
| Kubernetes node with the `folly` tag | `<host>.lolwtf.ca` | `riptide.lolwtf.ca` |
| Kubernetes node with the `offsite` tag | `<host>.lolwtf.ca` | `<target>` |
| Raspberry Pi | `<host>.<tailnet>` | `forge.lolwtf.ca` |

Build at the site of the target. When `<build-host>` and `<target>` differ, the closure goes from the build host through your machine to the target. Without `--build-host`, `nixos-rebuild` builds on your machine.

`<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`. From the LAN, `<host>.lolwtf.ca` also reaches a Pi that has an `ip` in the `rpis` section of `terraform/network/unifi/folly/clients.yaml`.

`static_records` in `terraform/network/unifi/folly/k8s.tf` declares the `lolwtf.ca` records of the `folly` nodes. No file in git declares the records of the `offsite` nodes or the DHCP reservations of the nodes.

## Deploy a change

> [!CAUTION]
> Auto-upgrade (`system.autoUpgrade` in `nix/system/nixos.nix`) rebuilds each host from `main` once a day. The `dates` value sets the time in Atlantic time, which is the host time zone. Auto-upgrade removes a change deployed from a branch. The Pi 4 and Pi Zero hosts have no auto-upgrade.

> [!NOTE]
> `boot` activates the new generation at the next reboot, and `switch` activates it now. `--no-reexec` stops `nixos-rebuild` from building and running the `nixos-rebuild` of the target configuration. For a Pi, that program is aarch64 or armv6l, which an x86_64 machine runs under emulation or not at all.

1. Deploy the configuration.

   ```bash
   nixos-rebuild boot --sudo --flake .#<host> --build-host <build-host> --target-host <target>
   ```

   If the change must be active now, use `switch` in place of `boot`. If the host is a Raspberry Pi, add `--no-reexec`.

   Result: The command prints `Done. The new configuration is` and a store path.

> [!CAUTION]
> If you reboot a node with `services.k8s.role = "control-plane"`, the Kubernetes API of its cluster stops.

2. If you used `boot`, reboot the host.
3. Make sure that no systemd unit failed.

   ```bash
   ssh <target> systemctl --failed --no-pager
   ```

   Result: The command prints `0 loaded units listed.`

## Deploy from GitHub Actions

The `nixos-deploy` workflow builds one Pi 4 or Pi Zero host on a GitHub runner and deploys it over the tailnet. It needs no build host. The `host` choices in `.github/workflows/nixos-deploy.yaml` list the hosts that it accepts.

1. Run the workflow.

   ```bash
   gh workflow run nixos-deploy.yaml -f host=<host> -f mode=boot
   ```

   If the change is not on `main`, add `--ref <branch>`. If the change must be active now, use `mode=switch`.

   Result: The command prints `Created workflow_dispatch event for nixos-deploy.yaml at <branch>`.

2. Wait for the run to complete. When `gh` asks for a run, select the `nixos-deploy` run.

   ```bash
   gh run watch --exit-status
   ```

   Result: The command prints `Run nixos-deploy (<run-id>) completed with 'success'`.

3. If you used `boot`, reboot the host.
4. Make sure that no systemd unit failed.

   ```bash
   ssh <target> systemctl --failed --no-pager
   ```

   Result: The command prints `0 loaded units listed.`

## Restore the previous generation

1. If the host boots, roll back to the previous generation.

   ```bash
   ssh <target> sudo nixos-rebuild switch --rollback
   ```

   Result: The command prints `Done. The new configuration is /nix/var/nix/profiles/system`.

2. If the host does not boot, restart it from the console. Select the previous generation in the boot menu.
3. If the change is on `main`, merge a pull request that reverts it before the next auto-upgrade.

## Add a Kubernetes node

This procedure adds an x86_64 Kubernetes node. The installer ISO shows `nix/images/INSTALL.md` at `/etc/README`.

> [!NOTE]
> Git does not document how a new node gets its Kubernetes certificates from the control plane. The NixOS kubernetes module installs `nixos-kubernetes-node-join` on each node for this step.

1. Add an entry for the host to `nix/hosts/default.nix`, with `tags` set to `[ "folly" ]` or `[ "offsite" ]`.

> [!NOTE]
> The host file of a node imports `../profiles/k8s-node.nix` and `../system/tailscale-disable.nix`. `k8s-node.nix` adds `homelab.disko.device`, the disk that the installer erases. Its default is `/dev/sda`.

2. Copy `nix/hosts/shale.nix` to `nix/hosts/<host>.nix`.
3. In the new file, set `homelab.disko.device` to the disk of the host.

> [!NOTE]
> The host cannot decrypt its SOPS file until you add its age recipient after the first boot. Until then, the host file declares no secret that the host needs to boot.

4. If the host needs secrets, create its SOPS file with only the operator key, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
5. Run the flake checks.

   ```bash
   mise run nix:check
   ```

   Result: The command completes without an error.

6. Build the closure of the host on `<build-host>`. If the host has the `offsite` tag, use another `offsite` node, such as `oldschool.lolwtf.ca`, as `<build-host>`.

   ```bash
   NIX_REMOTE=ssh-ng://<build-host> HOST=<host> mise run nix:build
   ```

   Result: The command prints the store path of the closure.

7. If the host has the `folly` tag, add it to `static_records` in `terraform/network/unifi/folly/k8s.tf`.
8. Open a pull request for the change.
9. If the host has the `folly` tag, apply the Terraform change through Atlantis, as [Apply a Terraform change](apply-a-terraform-change.md) describes.
10. Build the installer ISO.

    ```bash
    nix build .#iso
    ```

    Result: `result/iso/` contains the ISO file.

11. Write the ISO file to a USB drive.
12. Boot the host from the USB drive.

> [!WARNING]
> `homelab-install`, the install script on the ISO, erases the disk in `homelab.disko.device`. It erases the disk after you type the host name.

13. Run the install script. If the change is not on `main`, add `github:jonpulsifer/infra/<branch>` as the second argument.

    ```bash
    sudo homelab-install <host>
    ```

    Result: The script prints `>> Target disk:` and the disk, then asks for the host name.

14. Make sure that the target disk is the disk to erase.
15. Type the host name.

    Result: The script prints `>> Done. Reboot when ready:  sudo reboot`.

16. Reboot the host.
17. Make sure that no systemd unit failed.

    ```bash
    ssh <target> systemctl --failed --no-pager
    ```

    Result: The command prints `0 loaded units listed.`

18. If the host needs secrets, add its age recipient as [Manage SOPS secrets](manage-sops-secrets.md) describes.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| A deployed change is gone. | Auto-upgrade rebuilt the host from `main`. | Merge the change. |
| A systemd unit failed. | The change broke the unit. | Run `ssh <target> journalctl -u <unit> -n 80 --no-pager`. |
| `nixos-rebuild` prints `did you forget to use --ask-sudo-password?`. | A remote command failed. | Read the lines above that message. |
| The rollback finds no earlier generation. | `nix.gc` deleted the earlier generations. | Deploy the configuration of the last good commit. |
| `homelab-install` prints `Could not read homelab.disko.device`. | The configuration of the host does not evaluate, or it does not import `../profiles/k8s-node.nix`. | Type any text other than the host name to stop the script. Correct the host file. |

## Related

- [Test a change](test-a-change.md): the build commands, including builds on forge.
- [How changes ship](../platform/how-changes-ship.md): the apply path of each layer.
- [NixOS](../platform/nixos.md): the NixOS layer and the host registry.
- [Dotfiles](../../dotfiles/README.md): the user configuration that each deploy applies.
