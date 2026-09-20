tags:: runbook, windows, dotfiles

- Use this when setting up the Windows side of a box, or when the PowerShell profile, terminal or apps there have drifted from what git says they should be. The Windows config is the outer ring: it installs WSL, and the distro keeps its own clone and its own bootstrap. Source is `dotfiles/windows/`.
- # The rule that shapes everything else
	- **Nothing symlinks across the WSL boundary, in either direction.** Windows has its own clone; git is what keeps the two in sync.
	- `$PROFILE` has to resolve before the WSL VM is awake, symlinks into `\\wsl.localhost` come back as UNC paths that break tools which round-trip a handle to a path, and a Windows box has to be able to bootstrap itself before any distro exists. Executing a Windows binary from inside WSL is fine and unaffected — that is how commit signing already reaches `op-ssh-sign-wsl.exe`.
	- Line endings are pinned to LF by `dotfiles/.gitattributes`, and the clone forces `core.autocrlf=false` on top. PowerShell 7 reads LF and BOM-less UTF-8 without complaint.
- # From nothing to a working desk
	- One line, in any PowerShell. It re-execs itself under PowerShell 7 if it lands in 5.1:
	- ```powershell
	  irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1 | iex
	  ```
	- Add `-WithWsl` to install WSL and import a NixOS distro as well:
	- ```powershell
	  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1))) -WithWsl
	  ```
	- The stages, each idempotent: PowerShell 7 → `winget configure` the desired state in `dotfiles/windows/configuration.winget` → sparse clone to `%USERPROFILE%\src\github.com\jonpulsifer\infra` → `mise run bootstrap` → terminal font → optionally WSL.
	- The clone is blobless and sparse to `dotfiles/` only. `git pull` there is how the desk takes an update.
- # What owns what
	- **winget** owns the things mise has no business owning: PowerShell 7, Windows Terminal, Git, WSL, 1Password, VS Code, and the OS settings. Declared as a DSC v3 configuration, applied with `winget configure`, previewable with `--what-if`.
	- **mise** owns every CLI tool, from the same registry macOS and NixOS use. Windows has no Homebrew and no home-manager, so `mise-global-config.toml` carries an `os = ["windows"]` block for the shell tooling those two provide elsewhere. `btop` is absent there: it ships no Windows build.
	- **`deploy-dotfiles.ps1`** owns the symlinks, all of them on the Windows side. The shared `dotfiles/.config/git` is reused rather than forked — git on Windows reads `~/.config/git/config` too, and `dotfiles/windows/gitconfig` lands at `~/.gitconfig` to include it and override only what differs.
- # The shell
	- `dotfiles/windows/profile.ps1` is a loader; the content is in `dotfiles/windows/profile.d/`, loaded in filename order. The numeric prefixes are the order and they matter — mise has to be on PATH before anything looks for a tool.
	- The prompt is hand-rolled, in the same two-line shape as pure on the other platforms. There is no prompt engine. PowerShell has no RPROMPT, so the right-aligned duration and kube context are drawn by the prompt function itself before it returns the `❯`.
	- Set `DOTFILES_PROMPT_GIT=0` to turn off git information in the prompt entirely.
- # If the deploy refuses with "Developer Mode is off"
	- Creating a symlink needs Developer Mode or an elevated shell. The configuration pass turns it on, so run that first:
	- ```powershell
	  winget configure --file dotfiles\windows\configuration.winget
	  ```
	- Check what it would change without changing it by adding `--what-if`.
- # If Windows Terminal loses its settings
	- Terminal writes through the symlink normally, but a Terminal update or a settings reset can replace the file outright, orphaning it from the repo. The deploy is idempotent, so the fix is to run it again:
	- ```powershell
	  mise run --cd $HOME\src\github.com\jonpulsifer\infra\dotfiles bootstrap
	  ```
	- The replaced file is moved aside as `settings.json.bak-<timestamp>` rather than deleted, in case it holds something worth keeping.
- # If a tool will not install
	- Every CLI tool resolves through aqua, which only has a Windows asset where upstream ships one. A tool that fails on Windows and nowhere else needs an `os` filter in `mise-global-config.toml` next to the others, not a workaround in the profile.
- # If the prompt feels slow
	- The branch name comes from reading `.git/HEAD` directly, with no subprocess. Only the dirty marker costs a `git status`, and the prompt times that call: a repo where it runs long is remembered and the dirty check is skipped there afterwards, showing `branch?` instead of `branch*`.
	- A whole shell that starts slowly is more likely the kubectl completion cache in `40-aliases.ps1` regenerating, which happens once per kubectl version.
- # Validation
	- `mise run lint:ps` runs PSScriptAnalyzer. It runs in CI too, on the Linux runner — `pwsh` comes from mise, so the `.ps1` files get the same treatment the bash scripts get from shellcheck.
	- `mise run dotfiles:check` resolves every link source without touching the filesystem and fails on a missing one.
- # Related
	- [[Runbooks/Deploy a NixOS Host]] — what happens inside the distro once Windows has installed it
	- [[Runbooks/SOPS Secrets and Age Keys]] — the age key the distro needs before its first rebuild
	- [[Architecture/GitOps]] — how every other layer ships
