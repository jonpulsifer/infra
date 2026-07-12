tags:: runbook, nixos

- Use this when building, deploying, or rolling back a NixOS host from this repo. Host inventory lives in [[Fleet]]; architecture background lives in [[Architecture/NixOS]].
- # Quick checks
	- Confirm the host exists in the flake:
	- ```bash
	  nix eval --json .#nixosConfigurations --apply builtins.attrNames
	  ```
	- Build the system closure without deploying:
	- ```bash
	  nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel --no-link
	  ```
	- Run a harmless remote command through the host app:
	- ```bash
	  nix run .#<hostname> -- date
	  ```
- # Deploy safely
	- Prefer `boot` for remote or headless hosts. It builds and installs the new generation, but activation waits until the next reboot:
	- ```bash
	  nixos-rebuild boot --sudo --target-host <hostname> --flake .#<hostname>
	  ```
	- Use `switch` when immediate activation is intended:
	- ```bash
	  nixos-rebuild switch --flake .#<hostname> --target-host <hostname> --sudo
	  ```
	- For offsite or Tailscale-only paths, use the reachable target host name:
	- ```bash
	  nixos-rebuild boot --sudo --target-host <hostname>.<tailnet-name> --flake .#<hostname>
	  ```
- # After deploying
	- Verify the host answers:
	- ```bash
	  nix run .#<hostname> -- hostname
	  nix run .#<hostname> -- systemctl --failed --no-pager
	  ```
	- If the change touched a service, check that unit explicitly:
	- ```bash
	  nix run .#<hostname> -- systemctl --no-pager --full status <unit>.service
	  nix run .#<hostname> -- journalctl -u <unit>.service -n 80 --no-pager
	  ```
- # Roll back
	- If the host is reachable and the current generation is bad:
	- ```bash
	  nix run .#<hostname> -- sudo nixos-rebuild switch --rollback
	  ```
	- If remote access is risky, use the bootloader console or local access and select the previous generation.
- # Adding a host
	- Kubernetes nodes normally belong in `baseHostsSpec` in `flake.nix`; the hostname is the attr name and cluster membership comes from tags.
	- Standalone hosts with unique config get a file under `nix/hosts/<hostname>.nix` and a `flake.nix` host entry pointing at it.
	- Validate after adding a host:
	- ```bash
	  nix flake check
	  nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel --no-link
	  ```
- # Dotfiles
	- Dotfiles are mise-managed from the in-repo `dotfiles/` tree. `nix/system/mise-dotfiles.nix` carries that subtree into the system closure and runs `mise bootstrap --only dotfiles` during activation. See [[ADR/0011 Migrate dotfiles from chezmoi to mise]].
	- There is no dotfiles flake input and no home-manager integration.
- # Auto-upgrade caveat
	- Hosts auto-rebuild from GitHub `main`. A config deployed from a branch can be reverted by the next auto-upgrade unless the branch merges promptly. Treat a branch deploy as a test unless it has merged.
