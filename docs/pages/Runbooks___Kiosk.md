tags:: runbook
hosts:: homepi4, weatherpi4

- This runbook covers the Raspberry Pi kiosk hosts `homepi4` and `weatherpi4`. Both use `nix/services/kiosk.nix` with `container = false` and point Firefox directly at `https://hub.lolwtf.ca` — there is no local container on either host today. The display stack is **Cage on Wayland**; Firefox runs in kiosk/private-window mode against that URL.
- # Quick checks
	- Check Cage and Firefox:
	- ```bash
	  nix run .#<host> -- systemctl --no-pager --full status cage-tty1.service
	  nix run .#<host> -- pgrep -a firefox
	  ```
	- Expected:
		- `cage-tty1.service` is `active (running)`
		- Cage runs `/nix/store/...-kiosk-firefox`
		- Firefox runs with `--kiosk --private-window https://hub.lolwtf.ca`
	- Check that the remote hub is reachable from the host:
	- ```bash
	  nix run .#<host> -- curl -sk -o /dev/null -w '%{http_code}\n' https://hub.lolwtf.ca
	  ```
	- Expected HTTP status is `200`.
- # If the screen shows Firefox "Oops"
	- Both hosts point straight at the remote `https://hub.lolwtf.ca` — there is no local container and no readiness wait before Firefox launches, so "Oops" here almost always means the host couldn't reach that URL (Wi-Fi, DNS, or the hub itself) when Cage started.
	- Confirm reachability:
	- ```bash
	  nix run .#<host> -- curl -sk -o /dev/null -w '%{http_code}\n' https://hub.lolwtf.ca
	  ```
	- If it now answers `200`, restart Cage so Firefox reloads:
	- ```bash
	  nix run .#<host> -- sudo systemctl restart cage-tty1.service
	  ```
	- Verify Firefox relaunched:
	- ```bash
	  nix run .#<host> -- pgrep -a firefox
	  ```
- # If Cage is inactive
	- Check whether it is enabled and part of the graphical target:
	- ```bash
	  nix run .#<host> -- systemctl is-enabled cage-tty1.service
	  nix run .#<host> -- readlink -f /etc/systemd/system/default.target
	  nix run .#<host> -- systemctl --no-pager list-dependencies graphical.target
	  ```
	- Start it manually if needed:
	- ```bash
	  nix run .#<host> -- sudo systemctl start cage-tty1.service
	  ```
	- If this happens immediately after `nixos-rebuild switch`, note that NixOS may report:
	- ```text
	  NOT restarting the following changed units: cage-tty1.service
	  ```
	- In that case, restart Cage once:
	- ```bash
	  nix run .#<host> -- sudo systemctl restart cage-tty1.service
	  ```
- # Deploying changes
	- Build before switching:
	- ```bash
	  nix build .#nixosConfigurations.<host>.config.system.build.toplevel --no-link
	  ```
	- Switch a kiosk host:
	- ```bash
	  nixos-rebuild switch --flake .#<host> --target-host <host> --sudo
	  ```
	- For `weatherpi4` over Tailscale:
	- ```bash
	  nixos-rebuild switch --flake .#weatherpi4 --target-host weatherpi4.pirate-musical.ts.net --sudo
	  ```
	- After a switch, check whether Cage was restarted. If the switch output says it was not restarted, run:
	- ```bash
	  nix run .#<host> -- sudo systemctl restart cage-tty1.service
	  ```
