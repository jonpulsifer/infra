# dotfiles

The shell, editor, terminal multiplexer, git, SSH and agent configuration for
macOS, Linux, NixOS and Windows. `mise run bootstrap` installs it. The personal
identity is the default. `MISE_ENV=work` loads the work git identity from
`mise.work.toml`.

## Install

On macOS or Linux, from a clone of this repo:

```bash
curl https://mise.run | sh
mise trust -y dotfiles/mise.toml
mise run --cd dotfiles bootstrap
```

On a work machine, set `MISE_ENV=work` first.

On macOS, install [Homebrew](https://brew.sh/) first. `bootstrap` installs the
`Brewfile` and then links the files into `$HOME`. On Linux, it only links the
files. Each NixOS activation runs `bootstrap` through
`nix/system/mise-dotfiles.nix`, and `nix/home/jawn.nix` installs the shell
tools.

On Windows, run this in any PowerShell:

```powershell
irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1 | iex
```

The script applies `windows/configuration.winget`, makes a sparse clone of this
repo in `%USERPROFILE%\src\github.com\jonpulsifer\infra`, and runs
`bootstrap`. To also install WSL and a NixOS distro, pass `-WithWsl`:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1))) -WithWsl
```

Windows keeps its own clone, and no link crosses the WSL boundary. See
[Install a Windows desktop](https://wiki.lolwtf.ca/runbooks/install-a-windows-desktop/).

## Layout

- `mise.toml` holds the tasks and the personal identity. `mise.work.toml`
  overrides the identity.
- `mise-global-config.toml` becomes `~/.config/mise/config.toml`. It holds the
  global tools, and on Windows the shell tools that Homebrew and home-manager
  install elsewhere.
- `scripts/deploy-dotfiles.sh` and `windows/deploy-dotfiles.ps1` make the links.
- `skills/` is linked into the skills directory of each agent CLI.
- `windows/` holds the Windows installer, the winget configuration, the
  PowerShell profile and the Terminal settings.

## Test

```bash
mise run --cd dotfiles dotfiles:check   # print each link and change nothing
mise run check                          # at the repo root: shfmt, shellcheck and PSScriptAnalyzer
```

## Credits

ty @amcleodca, @burke, @dantecatalfamo, and @malob
