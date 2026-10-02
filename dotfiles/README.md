# dotfiles

The shell, editor, terminal multiplexer, git, SSH and agent configuration for
macOS, Linux, NixOS and Windows. `mise run bootstrap` installs it. The personal
git identity is the default, and `.config/git/config.work` holds the work one.

## Install

On macOS or Linux, from a clone of this repo:

```bash
curl https://mise.run | sh
mise trust -y dotfiles/mise.toml
mise run --cd dotfiles bootstrap
```

Run it from the main checkout, not a worktree: the links point into the
directory it runs from. On a work machine, set `MISE_ENV=work` first. CI and
the NixOS hosts run mise 2026.10.0, the release `nix/lib/mise.nix` pins.

On macOS, install [Homebrew](https://brew.sh/) first. `bootstrap` installs the
`Brewfile` and then links the files into `$HOME`. On Linux, it only links the
files. Each NixOS activation runs `dotfiles:deploy` from a store copy of this
directory through `nix/system/mise-dotfiles.nix`, with `MISE_ENV=hm` where
home-manager runs, and `nix/home/jawn.nix` installs the shell tools.

`bootstrap` links the files with `mise dotfiles apply`, which refuses to
replace a real file with a link. The read-only copies and the directory links from older
deploys move into `~/.dotfiles-backup/`; anything else in the way stops the
deploy and is named. Move it aside and run `bootstrap` again.

`.claude/settings.json` is a seed for `~/.claude/settings.json`, which Claude
Code writes to. Copy it there by hand.

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

- `mise.toml` holds the `[dotfiles]` table and the tasks. `mise.hm.toml`
  turns off the zsh and nvim entries that home-manager owns.
- `mise-global-config.toml` becomes `~/.config/mise/config.toml`. It holds the
  global tools, and on Windows the shell tools that Homebrew and home-manager
  install elsewhere.
- `.config/git/config.local.tera` renders `~/.config/git/config.local`: the
  1Password signing program and key on WSL, and the program on a work Mac.
- `windows/deploy-dotfiles.ps1` makes the Windows links.
- `skills/` is linked into the skills directory of each agent CLI.
- `windows/` holds the Windows installer, the winget configuration, the
  PowerShell profile and the Terminal settings.

## Test

```bash
mise run --cd dotfiles dotfiles:check   # deploy into scratch homes; change nothing in $HOME
mise run check                          # at the repo root: shfmt, shellcheck and PSScriptAnalyzer
```

## Credits

ty @amcleodca, @burke, @dantecatalfamo, and @malob
