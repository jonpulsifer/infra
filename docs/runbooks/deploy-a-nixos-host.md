---
title: Deploy a NixOS host
description: Deploy the NixOS configuration of a host from your machine or from GitHub Actions, or restore the previous generation.
---

Use this runbook to deploy a host before its daily auto-upgrade, or to restore the previous generation.

## Before you start

- Run `mise run devshell`.
- You need SSH access to the host as `jawn`.
- Read the [host sheet](../hosts/index.md).
- To restore a host that does not boot, you need its console.
- To deploy from GitHub Actions, sign in to `gh`.

`<host>` is the host name in `nix/hosts/default.nix`.

| Host | `<target>` | `<build-host>` |
| --- | --- | --- |
| `folly` node | `<host>.lolwtf.ca` | `riptide.lolwtf.ca` |
| `offsite` node | `<host>.lolwtf.ca` | `<target>` |
| Raspberry Pi | `<host>.<tailnet>` | `forge.lolwtf.ca` |

`<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`.

## Deploy a change

> [!CAUTION]
> Auto-upgrade rebuilds each host from `main` once a day and removes a change deployed from a branch. The Pi 4 and Pi Zero hosts have no auto-upgrade.

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

The `nixos-deploy` workflow builds and deploys a Pi 4 or Pi Zero host.

1. Run the workflow.

   ```bash
   gh workflow run nixos-deploy.yaml -f host=<host> -f mode=boot
   ```

   The workflow deploys only `main`. If the change must be active now, use `mode=switch`.

   Result: The command prints `Created workflow_dispatch event for nixos-deploy.yaml at main`.

2. Wait for the run to complete. When `gh` asks for a run, select the `nixos-deploy` run.

   ```bash
   gh run watch --exit-status
   ```

   Result: The command prints `Run nixos-deploy (<run-id>) completed with 'success'`.

3. Do steps 2 and 3 of [Deploy a change](#deploy-a-change).

## Restore the previous generation

1. If the host boots, roll back.

   ```bash
   ssh <target> sudo nixos-rebuild switch --rollback
   ```

   Result: The command prints `Done. The new configuration is /nix/var/nix/profiles/system`.

2. If the host does not boot, restart it from the console. Select the previous generation in the boot menu.
3. If the change is on `main`, merge a revert before the next auto-upgrade.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| A deployed change is gone. | Auto-upgrade rebuilt the host from `main`. | Merge the change. |
| A systemd unit failed. | The change broke the unit. | Run `ssh <target> journalctl -u <unit> -n 80 --no-pager`. |
| `nixos-rebuild` prints `did you forget to use --ask-sudo-password?`. | A remote command failed. | Read the lines above that message. |
| The rollback finds no earlier generation. | `nix.gc` in `nix/system/nixos.nix` deleted it. | Deploy the last good commit. |

## Related

- [Add a Kubernetes node](add-a-kubernetes-node.md): install a new node.
- [Test a change](test-a-change.md): the build commands.
- [NixOS](../platform/nixos.md): the host registry.
