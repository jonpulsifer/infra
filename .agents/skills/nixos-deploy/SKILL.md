---
name: nixos-deploy
description: Build, validate, and deploy NixOS host configurations in this infra repo. Use when rebuilding hosts, adding new systems, or rolling back.
---

## Workflow

1. **Validate** before touching hosts:
   ```bash
   nix flake check
   ```

2. **Build** (no side effects):
   ```bash
   nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel
   ```

3. **Deploy** — prefer `boot` for remote/headless hosts (activates on next reboot):
   ```bash
   # Safe (next reboot)
   nixos-rebuild boot --use-remote-sudo --target-host <hostname> --flake .#<hostname>

   # Immediate
   nixos-rebuild switch --flake .#<hostname> --target-host <hostname> --use-remote-sudo
   ```

4. **Rollback**:
   ```bash
   sudo nixos-rebuild switch --rollback
   ```

## Host Inventory

| Hostname   | Cluster | Role          | Arch        |
|------------|---------|---------------|-------------|
| nuc        | folly   | control-plane | x86_64      |
| optiplex   | folly   | worker        | x86_64      |
| riptide    | folly   | worker        | x86_64      |
| 800g2      | folly   | worker        | x86_64      |
| oldschool  | offsite | control-plane | x86_64      |
| retrofit   | offsite | worker        | x86_64      |
| cloudpi4   | –       | cloud svc     | aarch64     |
| homepi4    | –       | home auto     | aarch64     |
| screenpi4  | –       | kiosk         | aarch64     |
| oldboy     | –       | GCE VM        | x86_64      |

## Adding a New Host

1. Create `nix/hosts/<hostname>.nix`:
   ```nix
   { config, name, ... }: {
     imports = [ ../hardware/x86 ../services/common.nix ];
     networking.hostName = name;
   }
   ```
2. Register in `flake.nix` under `baseHostsSpec`.
3. Run `nix flake check`.

## Dotfiles Integration

Home-manager user config comes from the dotfiles flake via `inputs.dotfiles.homeModules.{basic,full}`.
- `basic` — used for all standard hosts (`nix/system/user.nix`)
- `full` — used for WSL image (`nix/images/wsl.nix`)
