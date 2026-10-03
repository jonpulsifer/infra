---
name: nixos-deploy
description: >-
  Build, deploy or roll back the NixOS configuration of a host in this repo.
  Use when rebuilding a host, adding one, or building a host image.
metadata:
  runbook: docs/runbooks/deploy-a-nixos-host.md
  wiki: https://wiki.lolwtf.ca/runbooks/deploy-a-nixos-host/
---

# NixOS deploy

The procedure is `docs/runbooks/deploy-a-nixos-host.md`. To add an x86
Kubernetes node, follow `docs/runbooks/add-a-kubernetes-node.md`. The platform
page is `docs/platform/nixos.md`, and each host has a sheet under
`docs/hosts/`. These notes cover what an agent needs beyond them.

## Notes

- A deploy changes a live host. Tell the owner the host, the mode and the
  commit before you run it. Use `boot` on a remote or headless host.
- CI builds and Cachix serves. Do not build a host closure in WSL or in a
  sandbox. `mise run nix:check` evaluates every host, and the merge to `main`
  runs the builds in `nix-ci.yaml`.
- Every host has `nix/hosts/<name>.nix` and an entry in
  `nix/hosts/default.nix`. `flake.nix` derives every output from that entry.
- Set `--build-host` and `--target-host` to the target, as the runbook shows.
  The target pulls what CI pushed to Cachix and builds the rest, so no closure
  passes through your machine or crosses the WAN.
- The Pi 4 and Pi Zero hosts have no auto-upgrade. The `nixos-deploy`
  workflow builds them and deploys the Pi 4 hosts.
- `radiopi0` and `blinkypi0` are armv6l with no binary cache. Cross-build
  them with the `nixos-deploy` or `nix-image-builder` workflow, never on the
  device.
- forge's EEPROM holds its boot order and HTTP fallback, outside the Nix
  closure. Read the live values with `rpi-eeprom-config` first, change only the
  value you mean to, and keep the HTTP entry while forge is headless.
  `docs/platform/nixos/netboot.md` has the rules.
- `nix run .#<host> -- <cmd>` works only for a host on the tailnet. The
  Kubernetes nodes run no Tailscale, so use `ssh <node>.lolwtf.ca` for them.
