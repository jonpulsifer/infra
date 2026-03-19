# logshipper (Vector)

Raspberry Pi (or other non‑Kubernetes) log shipper using Vector → Loki.

## Install (Debian/Ubuntu/Raspberry Pi OS)

1. Add Vector apt repo + install:
   ```sh
   curl -1sLf 'https://repositories.timber.io/public/vector/cfg/setup/bash.deb.sh' | sudo -E bash
   sudo apt-get update
   sudo apt-get install -y vector
   ```
2. Copy `vector.yaml` → `/etc/vector/vector.yaml`
3. Edit `/etc/vector/vector.yaml` and set the Loki endpoint (Ingress):
   ```yaml
   endpoint: https://loki.${SECRET_DOMAIN}
   ```
4. Install + start the systemd unit:
   ```sh
   sudo cp -v vector.service /etc/systemd/system/vector.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now vector
   ```

## Notes

- This config ships systemd journal entries to Loki.
- If Loki requires auth, add `basic` or `bearer` auth in the sink config.
