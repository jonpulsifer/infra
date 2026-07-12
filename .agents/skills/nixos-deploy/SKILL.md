---
name: nixos-deploy
description: Build, validate, and deploy NixOS host configurations in this infra repo. Use when rebuilding hosts, adding new systems, or rolling back.
metadata:
  runbook: docs/pages/Runbooks___Deploy a NixOS Host.md
  wiki: https://wiki.lolwtf.ca/runbooks/deploy-a-nixos-host/
---

# NixOS Deploy

Canonical human runbook: `docs/pages/Runbooks___Deploy a NixOS Host.md`.
Reference bridge: `references/runbook.md`.

## Agent Notes

- Validate before touching hosts when feasible: `nix flake check`.
- Build without side effects: `nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel --no-link`.
- Run harmless remote commands through the host app: `nix run .#<hostname> -- date`.
- Prefer `nixos-rebuild boot --sudo --target-host <hostname> --flake .#<hostname>` for remote/headless hosts.
- Use `switch` only when immediate activation is intended.
- Roll back with `nix run .#<hostname> -- sudo nixos-rebuild switch --rollback` when the host is reachable.
- Dotfiles are mise-managed from in-repo `dotfiles/` via `nix/system/mise-dotfiles.nix`; there is no dotfiles flake input or home-manager integration.
