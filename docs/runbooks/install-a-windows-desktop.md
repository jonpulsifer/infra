---
title: Install a Windows desktop
description: Install the owner's Windows configuration on a desktop with one PowerShell script, update it, add the NixOS WSL distro, and test a change to the Windows dotfiles.
---

Use this runbook to install or update the owner's Windows configuration on a desktop, such as [tallboy](../hosts/tallboy.md) or [atomic](../hosts/atomic.md). It also adds the NixOS WSL distro and tests a change to the Windows dotfiles. One script, `dotfiles/windows/bootstrap.ps1`, clones the repository and installs the parts in this table.

| Part | What it installs |
| --- | --- |
| `dotfiles/windows/configuration.winget` | Applications and OS settings |
| `mise run bootstrap` | CLI tools and the dotfile links |
| Nerd Font | A terminal font with icons |
| vibranceGUI | A tool that sets the GPU color saturation (digital vibrance) |

> [!NOTE]
> Windows and the WSL distro each have their own checkout. No link crosses between the two, so the PowerShell profile works when WSL is not running.

## Before you start

- You need winget 1.11 or later, from App Installer.
- You need an account that can approve administrator prompts.
- To add the WSL distro, you need the operator age key. See [Manage SOPS secrets](manage-sops-secrets.md).

The bootstrap script makes a sparse checkout of `dotfiles/` at `$HOME\src\github.com\jonpulsifer\infra`.

## Install the desktop

1. Open PowerShell.
2. Run the bootstrap script. Approve each administrator prompt.

   ```powershell
   irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1 | iex
   ```

   Result: The command prints `Done. Open a new PowerShell 7 tab to pick up the profile.` as its last line.

3. Open a new PowerShell 7 tab.
4. If the desktop must send metrics and logs to folly's Prometheus and VictoriaLogs, do [Install Windows monitoring](install-windows-monitoring.md).

## Update the desktop

1. Open PowerShell 7.
2. Go to the checkout.

   ```powershell
   cd $HOME\src\github.com\jonpulsifer\infra
   ```

3. Pull `main`.

   ```powershell
   git pull --ff-only
   ```

   Result: The command prints `Already up to date.` or the changed files.

4. If `configuration.winget` changed, apply it. Accept each prompt. To see the changes first, add `--what-if`.

   ```powershell
   winget configure --file dotfiles\windows\configuration.winget
   ```

   Result: The command prints `Configuration successfully applied.`

5. Run the dotfiles bootstrap.

   ```powershell
   mise run --cd dotfiles bootstrap
   ```

   Result: The command prints `Windows dotfiles deployed.` as its last line.

## Add the NixOS WSL distro

1. Open PowerShell 7.
2. Run the bootstrap script with `-WithWsl`.

   ```powershell
   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1))) -WithWsl
   ```

   Result: The command prints `Distro 'NixOS' is up. Finish inside it:` and the next commands.

3. Open the distro.

   ```powershell
   wsl -d NixOS
   ```

4. Clone the repository.

   ```bash
   git clone https://github.com/jonpulsifer/infra ~/src/github.com/jonpulsifer/infra
   ```

   Result: The command prints `Cloning into` and the path of the checkout.

5. Go to the checkout.

   ```bash
   cd ~/src/github.com/jonpulsifer/infra
   ```

6. Put the operator age key in `~/.config/age/keys.txt`.
7. Apply the `wsl` configuration.

   ```bash
   sudo nixos-rebuild switch --flake .#wsl
   ```

   Result: The command prints `Done. The new configuration is` and a store path.

## Test a Windows dotfiles change

1. On any machine, go to the root of a checkout.
2. Lint the PowerShell files.

   ```bash
   mise run lint:ps
   ```

   Result: The command prints `PSScriptAnalyzer: clean.`

3. On the desktop, in the checkout, make sure every file that a dotfiles link points to exists.

   ```powershell
   mise run --cd dotfiles dotfiles:check
   ```

   Result: The command prints no `source missing` warning, and prints `Windows dotfiles deployed.` as its last line.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `winget configure` fails on a Store package. | The package needs a license prompt, and the bootstrap script turns prompts off. | Do step 4 of [Update the desktop](#update-the-desktop). |
| `mise run bootstrap` stops with `Developer Mode is off and this shell is not elevated`. | The winget configuration did not run. | Do step 4 of [Update the desktop](#update-the-desktop). |
| Windows Terminal does not use the settings from the checkout. | A Terminal update replaced `settings.json`. | Do step 5 of [Update the desktop](#update-the-desktop). The old file stays as `settings.json.bak-<timestamp>`. |
| `mise install` fails for a tool on Windows only. | The tool has no Windows build. | In `dotfiles/mise-global-config.toml`, give the tool an `os` filter without `windows`. |
| vibranceGUI stops with `Hash mismatch`. | The download is not the pinned file. | Find why the upstream file changed. Change `-Url` and `-Sha256` in `Install-VibranceGui.ps1` together. |
| The prompt shows the branch with `?`. | `git status` took more than 150 ms, so the prompt does not check for uncommitted changes in that repository. | Open a new shell to check again. To remove the git segment, set the user environment variable `DOTFILES_PROMPT_GIT` to `0`. |
| Step 2 of [Add the NixOS WSL distro](#add-the-nixos-wsl-distro) prints `distro 'NixOS' already exists`. | The script does not replace a distro. | Use the existing distro. |

## Related

- [Install Windows monitoring](install-windows-monitoring.md)
- [Deploy a NixOS host](deploy-a-nixos-host.md)
- [tallboy](../hosts/tallboy.md) and [atomic](../hosts/atomic.md): the Windows desktops
