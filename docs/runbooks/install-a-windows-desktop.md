---
title: Install a Windows desktop
description: "Set up a Windows desktop with one bootstrap script: winget desired state, dotfiles, the PowerShell profile and optional NixOS-WSL."
---

Use this when setting up the Windows side of a box, or when the PowerShell profile, terminal or apps there have drifted from what git says they should be. The Windows config is the outer ring: it installs WSL, and the distro keeps its own clone and its own bootstrap. Source is `dotfiles/windows/`.

## The rule that shapes everything else

**Nothing symlinks across the WSL boundary, in either direction.** Windows has its own clone; git is what keeps the two in sync.

`$PROFILE` has to resolve before the WSL VM is awake, symlinks into `\\wsl.localhost` come back as UNC paths that break tools which round-trip a handle to a path, and a Windows box has to be able to bootstrap itself before any distro exists. Executing a Windows binary from inside WSL is fine and unaffected — that is how commit signing already reaches `op-ssh-sign-wsl.exe`.

Line endings are pinned to LF by `dotfiles/.gitattributes`, and the clone forces `core.autocrlf=false` on top. PowerShell 7 reads LF and BOM-less UTF-8 without complaint.

## From nothing to a working desk

One line, in any PowerShell. It re-execs itself under PowerShell 7 if it lands in 5.1:

```powershell
irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1 | iex
```

Add `-WithWsl` to install WSL and import a NixOS distro as well:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1))) -WithWsl
```

The stages, each idempotent: PowerShell 7 → `winget configure` the desired state in `dotfiles/windows/configuration.winget` → sparse clone to `%USERPROFILE%\src\github.com\jonpulsifer\infra` → `mise run bootstrap` → terminal font → optionally WSL.

The clone is blobless and sparse to `dotfiles/` only. `git pull` there is how the desk takes an update.

## What owns what

**winget** owns the things mise has no business owning: PowerShell 7, Windows Terminal, Git, WSL, 1Password, VS Code, and the OS settings. Declared as a DSC v3 configuration in `dotfiles/windows/configuration.winget`, applied with `winget configure`, previewable with `--what-if`. That one file is the bundle — `winget export`/`import` describes a strictly smaller thing (no OS settings, no dependency order, no elevation), so there is no second list to keep in step.

**Which source a package comes from** is per-package. `source: msstore` with a Store product id for Windows Terminal (`9N0DX20HK701`) and WSL (`9P9TQF7MRM4R`): both sources ship the same MSIX and the same package family, but a sideloaded MSIX carries no Store licence and so never auto-updates, and the community manifests lag. `source: winget` for everything else — PowerShell deliberately, because the Store build runs in a sandbox that virtualizes parts of the filesystem and registry and that is a poor fit for the shell everything else runs inside; 1Password because its community manifest is already the same MSIX the Store delivers; Git and mise because they are not on the Store at all.

**Two things are in neither catalogue** and get pinned, hash-verified, per-user installers of their own, run from `bootstrap.ps1`: the CaskaydiaCove Nerd Font (`Install-NerdFont.ps1`) and vibranceGUI (`Install-VibranceGui.ps1`). Both check the download against a pinned SHA256 before it goes anywhere.

**mise** owns every CLI tool, from the same registry macOS and NixOS use. Windows has no Homebrew and no home-manager, so `mise-global-config.toml` carries an `os = ["windows"]` block for the shell tooling those two provide elsewhere. `btop` is absent there: it ships no Windows build.

**`deploy-dotfiles.ps1`** owns the symlinks, all of them on the Windows side. The shared `dotfiles/.config/git` is reused rather than forked — git on Windows reads `~/.config/git/config` too, and `dotfiles/windows/gitconfig` lands at `~/.gitconfig` to include it and override only what differs.

## The shell

`dotfiles/windows/profile.ps1` is a loader; the content is in `dotfiles/windows/profile.d/`, loaded in filename order. The numeric prefixes are the order and they matter — mise has to be on PATH before anything looks for a tool.

The prompt is hand-rolled, in the same two-line shape as pure on the other platforms. There is no prompt engine. PowerShell has no RPROMPT, so the right-aligned duration and kube context are drawn by the prompt function itself before it returns the `❯`.

Set `DOTFILES_PROMPT_GIT=0` to turn off git information in the prompt entirely.

## If a Store package will not install

`winget configure` runs with `--disable-interactivity`. A Store package that wants a licence acquired interactively fails there rather than prompting. Run the pass on its own to see the prompt:

```powershell
winget configure --file dotfiles\windows\configuration.winget
```

Check a Store product id against the catalogue before changing one — the ids are opaque, and installing the wrong one is silent:

```bash
curl -s "https://displaycatalog.mp.microsoft.com/v7.0/products/9N0DX20HK701?market=US&languages=en-us&fieldsTemplate=Details" | head -c 400
```

## If vibranceGUI stops matching its hash

`Install-VibranceGui.ps1` pins upstream `juv/vibranceGUI` v2.5.0 by URL and SHA256, and refuses to install anything else. Upstream has published no newer release; a v3.0.0 exists on a fork with no established provenance, and this does not follow it. Moving deliberately means changing both `-Url` and `-Sha256`.

## If the deploy refuses with "Developer Mode is off"

Creating a symlink needs Developer Mode or an elevated shell. The configuration pass turns it on, so run that first:

```powershell
winget configure --file dotfiles\windows\configuration.winget
```

Check what it would change without changing it by adding `--what-if`.

## If Windows Terminal loses its settings

Terminal writes through the symlink normally, but a Terminal update or a settings reset can replace the file outright, orphaning it from the repo. The deploy is idempotent, so the fix is to run it again:

```powershell
mise run --cd $HOME\src\github.com\jonpulsifer\infra\dotfiles bootstrap
```

The replaced file is moved aside as `settings.json.bak-<timestamp>` rather than deleted, in case it holds something worth keeping.

## If a tool will not install

Every CLI tool resolves through aqua, which only has a Windows asset where upstream ships one. A tool that fails on Windows and nowhere else needs an `os` filter in `mise-global-config.toml` next to the others, not a workaround in the profile.

## If the prompt feels slow

The branch name comes from reading `.git/HEAD` directly, with no subprocess. Only the dirty marker costs a `git status`, and the prompt times that call: a repo where it runs long is remembered and the dirty check is skipped there afterwards, showing `branch?` instead of `branch*`.

A whole shell that starts slowly is more likely the kubectl completion cache in `40-aliases.ps1` regenerating, which happens once per kubectl version.

## Validation

`mise run lint:ps` runs PSScriptAnalyzer. It runs in CI too, on the Linux runner — `pwsh` comes from mise, so the `.ps1` files get the same treatment the bash scripts get from shellcheck.

`mise run dotfiles:check` resolves every link source without touching the filesystem and fails on a missing one.

## Related

- [Deploy a NixOS host](deploy-a-nixos-host.md) — what happens inside the distro once Windows has installed it
- [Manage SOPS secrets](manage-sops-secrets.md) — the age key the distro needs before its first rebuild
- [How changes ship](../platform/how-changes-ship.md) — how every other layer ships
