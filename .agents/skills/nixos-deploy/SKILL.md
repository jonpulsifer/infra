---
name: nixos-deploy
description: >-
  Build, validate, and deploy NixOS host configurations in this infra repo. Use
  when rebuilding a host, adding a new one, building an image, or rolling back.
metadata:
  runbook: docs/pages/Runbooks___Deploy a NixOS Host.md
  wiki: https://wiki.lolwtf.ca/runbooks/deploy-a-nixos-host/
---

# NixOS Deploy

Canonical human runbook: `docs/pages/Runbooks___Deploy a NixOS Host.md`. Layer
background: `docs/pages/Architecture___NixOS.md`. Host inventory:
`docs/pages/Fleet.md`. This file holds only the agent-specific guidance.

## Agent notes

- Deploying touches live hardware. Say what you are about to do before you do
  it, and prefer `boot` over `switch` on remote or headless hosts.
- Validate and build without side effects first:
  ```bash
  nix flake check
  nix build .#nixosConfigurations.<host>.config.system.build.toplevel --no-link
  ```
- Deploy:
  ```bash
  nixos-rebuild boot   --sudo --target-host <host> --flake .#<host>   # next reboot
  nixos-rebuild switch --sudo --target-host <host> --flake .#<host>   # immediately
  ```
- **A branch deploy is temporary.** Hosts auto-upgrade from `main` daily at
  03:37, so an unmerged config silently reverts. Merge promptly or treat the
  deploy as a test.
- Kubernetes nodes are declared **inline in `flake.nix`**, not in `nix/hosts/`.
  Only the Pis and the GCE VM have a `nix/hosts/<name>.nix`.
- `radiopi0` and `blinkypi0` are armv6l with no binary cache and
  `system.autoUpgrade` disabled — they cross-build on `spore` (aarch64) and are
  pushed with `--target-host`. Never try to build them on-device.
- `rackpi5` is diskless and HTTP-boots a signed image from `spore`. There is no
  SD, NFS, or TFTP fallback — deploy and verify `spore`'s publisher before any
  change that affects its boot chain, and remember the EEPROM config lives
  outside the Nix closure.
- `nix run .#<host> -- <cmd>` reaches hosts over the tailnet only; it fails from
  a plain LAN/WSL shell. Use `<host>.lolwtf.ca` over SSH there instead.
- Roll back on a reachable host: `nixos-rebuild switch --rollback`.
