# dotfiles

Nix flake-based [home-manager](https://github.com/nix-community/home-manager) dotfiles. Shell environment, configuration, and personality — not development tools.

![glamanonymous](/glamanon.jpeg)

## Philosophy

These dotfiles manage **configuration only**: shell (zsh), editor (vim), multiplexer (tmux), git, AI agents, SSH, and security tools. Development tools (language runtimes, cloud CLIs, infrastructure tools) are **not** installed globally.

Instead, dev tools are provisioned per-project via:

- **[mise](https://mise.jdx.dev)** — polyglot runtime manager, available everywhere via `basic.nix`
- **[Nix dev shells](https://nix.dev/tutorials/first-steps/dev-environment)** — reproducible, per-project environments via `flake.nix`

## Configurations

| Name       | System         | Profile                                              |
|------------|----------------|------------------------------------------------------|
| `full`     | x86_64-linux   | Full workstation (AI agents, SSH, security tools)     |
| `basic`    | x86_64-linux   | Base shell personality (git, zsh, tmux, vim, mise)    |
| `arm`      | aarch64-linux  | Base shell personality (ARM)                          |
| `homebook` | aarch64-darwin | Full workstation + macOS (Ghostty, fonts)             |
| `work`     | aarch64-darwin | Work profile (MoonPay, 1Password SSH, Homebrew)       |
| `pulse`    | x86_64-linux   | Minimal container (git + zsh only)                    |

## Installation

Install [Nix](https://determinate.systems/nix-installer/):

```bash
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
```

### Linux

```bash
nix run
```

### macOS

```bash
nix build github:jonpulsifer/dotfiles#darwinConfigurations.$(hostname).system
./result/sw/bin/darwin-rebuild switch --flake .
```

## What's included

**Base (all profiles):** git, zsh (pure prompt, fzf, syntax highlighting), tmux, vim, mise, bat, delta, eza, ripgrep, fzf, btop, fd, jq

**Full workstation adds:** AI agent tooling (Claude Code, Cursor, OpenCode, Gemini + MCP servers), SSH config, 1Password CLI, age, sops, GPG

## Dev tools

To get development tools in a project, add a `.mise.toml`:

```toml
[tools]
go = "latest"
node = "22"
kubectl = "latest"
terraform = "1.12"
```

Or use a Nix dev shell in your project's `flake.nix`:

```nix
devShells.default = pkgs.mkShell {
  packages = with pkgs; [ go gopls nodejs kubectl ];
};
```

## Credits

ty @amcleodca, @burke, @dantecatalfamo, and @malob
