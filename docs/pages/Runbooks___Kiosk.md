tags:: runbook
hosts:: homepi4, weatherpi4

- This runbook covers the Raspberry Pi kiosk hosts `homepi4` and `weatherpi4`. Both use `nix/services/kiosk.nix`. The display stack is **Cage on Wayland**; Firefox runs in kiosk/private-window mode against the configured kiosk URL. For container-backed kiosks, the default URL is `http://localhost:8080`.
- # Quick checks
	- Check Cage and Firefox:
	- ```bash
	  nix run .#<host> -- systemctl --no-pager --full status cage-tty1.service
	  nix run .#<host> -- pgrep -a firefox
	  ```
	- Expected:
		- `cage-tty1.service` is `active (running)`
		- Cage runs `/nix/store/...-kiosk-firefox`
		- Firefox runs with `--kiosk --private-window http://localhost:8080`
	- Check the container-backed app:
	- ```bash
	  nix run .#<host> -- systemctl --no-pager --full status docker-kiosk.service
	  nix run .#<host> -- docker ps
	  nix run .#<host> -- journalctl -u docker-kiosk.service -n 50 --no-pager
	  ```
	- Expected:
		- `docker-kiosk.service` is active
		- Container `kiosk` is running `ghcr.io/jonpulsifer/hub:latest`
		- Port mapping includes `0.0.0.0:8080->8080/tcp`
		- Recent logs include `GET / 200` and, for the weather app, `GET /api/weather 200`
- # If the screen shows Firefox "Oops"
	- This is usually Firefox loading before the local container is ready. The module uses a wrapper that waits for the kiosk URL before launching Firefox, but after manual switches or service restarts it is still worth checking the order of events.
	- Check whether the app is serving:
	- ```bash
	  nix run .#<host> -- journalctl -u docker-kiosk.service -n 80 --no-pager
	  ```
	- If the app is healthy and logging `GET / 200`, refresh the display by restarting Cage:
	- ```bash
	  nix run .#<host> -- sudo systemctl restart cage-tty1.service
	  ```
	- Verify Firefox relaunched:
	- ```bash
	  nix run .#<host> -- pgrep -a firefox
	  nix run .#<host> -- journalctl -u docker-kiosk.service -n 20 --no-pager
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
- # If the container is down
	- Restart the container service:
	- ```bash
	  nix run .#<host> -- sudo systemctl restart docker-kiosk.service
	  nix run .#<host> -- systemctl --no-pager --full status docker-kiosk.service
	  ```
	- Then restart Cage so Firefox reconnects to the now-running app:
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
