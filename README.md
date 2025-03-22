# infra

```bash
# Get started with the repo
nix develop

# Build a specific NixOS system
nix build .#nixosConfigurations.<system>.config.system.build.toplevel

# Build installation media
nix build .#iso         # x86_64 ISO
nix build .#wsl         # WSL tarball
nix build .#rpi4        # Raspberry Pi 4 image
```
