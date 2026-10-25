---
title: Install a Windows desktop
description: Install the owner's Windows configuration on a desktop with one PowerShell script, update it, add or replace the NixOS WSL distro, and test a change to the Windows dotfiles.
---

Use this runbook to install or update the owner's Windows configuration on a desktop, such as [tallboy](../hosts/tallboy.md) or [atomic](../hosts/atomic.md). It also adds or replaces the NixOS WSL distro and tests a change to the Windows dotfiles. The dotfiles live in the owner's [dotfiles repository](https://github.com/jonpulsifer/dotfiles), not in this one. One script, `windows/bootstrap.ps1` in that repository, clones it and installs the parts in this table.

| Part | What it installs |
| --- | --- |
| `windows/configuration.winget` | Applications and OS settings |
| `mise run bootstrap` | CLI tools and the dotfile links |
| Nerd Font | A terminal font with icons |
| vibranceGUI | A tool that sets the GPU color saturation (digital vibrance) |

> [!NOTE]
> Windows and the WSL distro each have their own checkout. No link crosses between the two, so the PowerShell profile works when WSL is not running.

The distro keeps `/home` on its own virtual disk, the `homelab.wsl.homeDisk` option in `nix/images/wsl-home.nix`. At each boot the distro attaches that disk and mounts it on `/home`. Without the disk, a user shell waits 30 seconds for `/home`, then exits. Root still gets a shell. Replacing the distro deletes only its root disk, so home stays.

## Before you start

- You need winget 1.11 or later, from App Installer.
- You need an account that can approve administrator prompts.
- To add the WSL distro, you need the operator age key. See [Manage SOPS secrets](manage-sops-secrets.md).

The bootstrap script clones the dotfiles repository to `$HOME\src\github.com\jonpulsifer\dotfiles`.

## Install the desktop

1. Open PowerShell.
2. Run the bootstrap script. Approve each administrator prompt.

   ```powershell
   irm https://raw.githubusercontent.com/jonpulsifer/dotfiles/main/windows/bootstrap.ps1 | iex
   ```

   Result: The command prints `Done. Open a new PowerShell 7 tab to pick up the profile.` as its last line.

3. Open a new PowerShell 7 tab.
4. If the desktop must send metrics and logs to folly's Prometheus and VictoriaLogs, do [Install Windows monitoring](install-windows-monitoring.md).

## Update the desktop

1. Open PowerShell 7.
2. Go to the checkout.

   ```powershell
   cd $HOME\src\github.com\jonpulsifer\dotfiles
   ```

3. Pull `main`.

   ```powershell
   git pull --ff-only
   ```

   Result: The command prints `Already up to date.` or the changed files.

4. If `configuration.winget` changed, apply it. Accept each prompt. To see the changes first, add `--what-if`.

   ```powershell
   winget configure --file windows\configuration.winget
   ```

   Result: The command prints `Configuration successfully applied.`

5. Run the dotfiles bootstrap.

   ```powershell
   mise run bootstrap
   ```

   Result: The command prints `Windows dotfiles deployed.` as its last line.

## Add the NixOS WSL distro

1. Open PowerShell 7.
2. Run the bootstrap script with `-WithWsl`.

   ```powershell
   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jonpulsifer/dotfiles/main/windows/bootstrap.ps1))) -WithWsl
   ```

   Result: The command prints `Distro 'NixOS' is up. Finish inside it:` and the next commands.

3. Stage the `wsl` configuration. It takes effect at the next boot.

   ```powershell
   wsl -d NixOS -- sudo nixos-rebuild boot --flake github:jonpulsifer/infra#wsl
   ```

4. Stop the distro.

   ```powershell
   wsl --terminate NixOS
   ```

5. Create the home disk. If the desktop is not tallboy, set `homelab.wsl.homeDisk` for it first.

   ```powershell
   wsl -d NixOS -u root -- wsl-home-init
   ```

   Result: The command prints `Created D:\WSL\home.vhdx.`, or `The home disk is already attached.` when it exists.

6. Stop the distro again, so that the next boot mounts the home disk.

   ```powershell
   wsl --terminate NixOS
   ```

7. Open the distro.

   ```powershell
   wsl -d NixOS
   ```

8. Clone the repository.

   ```bash
   git clone https://github.com/jonpulsifer/infra ~/src/github.com/jonpulsifer/infra
   ```

   Result: The command prints `Cloning into` and the path of the checkout.

9. Put the operator age key in `~/.config/age/keys.txt`.

## Replace the WSL distro

Replace the distro to start from a fresh root disk. Home stays on the home disk.

1. In the distro, build the image from `main`.

   ```bash
   gh workflow run nix-image-builder.yaml -f image=wsl
   ```

   Result: The run uploads `nixos.wsl` to the `homelab-ng-free` bucket.

2. Copy the image to the Windows downloads folder. Replace `<user>` with the Windows user name.

   ```bash
   gcloud storage cp gs://homelab-ng-free/nixos.wsl /mnt/c/Users/<user>/Downloads/nixos.wsl
   ```

3. Open PowerShell 7 and go to the dotfiles checkout.

   ```powershell
   cd $HOME\src\github.com\jonpulsifer\dotfiles
   ```

4. Replace the distro. `-Location` is the folder that holds the distro's folder, such as `D:\WSL` on tallboy.

   ```powershell
   .\windows\Install-Wsl.ps1 -TarballPath $HOME\Downloads\nixos.wsl -Location D:\WSL -Replace
   ```

   Result: The command prints `Distro 'NixOS' is up.` The script refuses a distro whose `/home` is not on the home disk.

5. Open the distro and check that `/home` is on the home disk.

   ```bash
   findmnt -no LABEL /home
   ```

   Result: The command prints `nixos-home`.

6. Install the tools that the home disk does not keep, such as mise's installs.

   ```bash
   mise install
   ```

## Test a Windows dotfiles change

1. On the desktop, go to the dotfiles checkout.
2. Make sure every file that a dotfiles link points to exists.

   ```powershell
   mise run dotfiles:check
   ```

   Result: The command prints no `source missing` warning, and prints `Windows dotfiles deployed.` as its last line.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `winget configure` fails on a Store package. | The package needs a license prompt, and the bootstrap script turns prompts off. | Do step 4 of [Update the desktop](#update-the-desktop). |
| `mise run bootstrap` stops with `Developer Mode is off and this shell is not elevated`. | The winget configuration did not run. | Do step 4 of [Update the desktop](#update-the-desktop). |
| Windows Terminal does not use the settings from the checkout. | A Terminal update replaced `settings.json`. | Do step 5 of [Update the desktop](#update-the-desktop). The old file stays as `settings.json.bak-<timestamp>`. |
| `mise install` fails for a tool on Windows only. | The tool has no Windows build. | In `mise-global-config.toml` of the dotfiles repository, give the tool an `os` filter without `windows`. |
| vibranceGUI stops with `Hash mismatch`. | The download is not the pinned file. | Find why the upstream file changed. Change `-Url` and `-Sha256` in `Install-VibranceGui.ps1` together. |
| The prompt shows the branch with `?`. | `git status` took more than 150 ms, so the prompt does not check for uncommitted changes in that repository. | Open a new shell to check again. To remove the git segment, set the user environment variable `DOTFILES_PROMPT_GIT` to `0`. |
| Step 2 of [Add the NixOS WSL distro](#add-the-nixos-wsl-distro) prints `distro 'NixOS' already exists`. | The script replaces a distro only with `-Replace`. | Use the existing distro, or do [Replace the WSL distro](#replace-the-wsl-distro). |
| The distro prints `/home is not mounted` and closes the shell. | The home disk did not attach. | Run `wsl -d NixOS -u root -- systemctl status wsl-home-disk`. If the VHDX is missing, do steps 5 and 6 of [Add the NixOS WSL distro](#add-the-nixos-wsl-distro). |

## Related

- [Install Windows monitoring](install-windows-monitoring.md)
- [Deploy a NixOS host](deploy-a-nixos-host.md)
- [tallboy](../hosts/tallboy.md) and [atomic](../hosts/atomic.md): the Windows desktops
