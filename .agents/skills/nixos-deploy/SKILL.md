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

3. **Run commands on a host**:
   ```bash
   nix run .#<hostname> -- date
   nix run .#<hostname> -- <command> [args...]
   ```

4. **Deploy** — prefer `boot` for remote/headless hosts (activates on next reboot):
   ```bash
   # Safe (next reboot)
   nixos-rebuild boot --use-remote-sudo --target-host <hostname> --flake .#<hostname>

   # Immediate
   nixos-rebuild switch --flake .#<hostname> --target-host <hostname> --use-remote-sudo
   ```

5. **Rollback**:
   ```bash
   sudo nixos-rebuild switch --rollback
   ```

## Host Inventory

| Hostname   | Cluster | Role          | Arch        |
|------------|---------|---------------|-------------|
| optiplex   | folly   | control-plane | x86_64      |
| riptide    | folly   | worker        | x86_64      |
| oldschool  | offsite | worker        | x86_64      |
| retrofit   | offsite | control-plane | x86_64      |
| cloudpi4   | –       | cloud svc     | aarch64     |
| homepi4    | –       | home auto     | aarch64     |
| weatherpi4 | –       | kiosk         | aarch64     |
| oldboy     | –       | GCE VM        | x86_64      |

## Adding a New Host

**Kubernetes node** — add to `flake.nix` `baseHostsSpec` only (hostname is the attr name; cluster comes from tags):

```nix
newnode = { tags = [ "folly" ]; role = "control-plane"; }; # role defaults to worker
```

**Host with unique config** — add a file under `nix/hosts/` and reference it:

```nix
newpi = {
  system = "aarch64-linux";
  modules = [ ./nix/hosts/newpi.nix ];
};
```

K8s nodes with extra services can use `imports` and `extraConfig` in the spec (see `oldschool` in `flake.nix`).

Run `nix flake check` after changes.

## Dotfiles Integration

Home-manager user config comes from the dotfiles flake via `inputs.dotfiles.homeModules.{basic,full}`.
- `basic` — used for all standard hosts (`nix/system/user.nix`)
- `full` — used for WSL image (`nix/images/wsl.nix`)
