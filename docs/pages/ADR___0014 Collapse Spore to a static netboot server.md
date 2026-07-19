status:: accepted
date:: 2026-07-19
deciders:: [[jawn]]
tags:: adr

- # Context
	- [[ADR/0013 Git and Nix own the Spore boot catalog]] kept a Next.js application on the `spore` host: an iPXE catalog, a MAC-keyed boot-decision engine, a read-only status UI, and a SQLite observation database, fronted by nginx.
	- Once boot policy became immutable and Nix-generated, ~90% of that app only echoed Git state (`clients.yaml` + `nix/hosts/spore.nix`) back through a browser. The one piece of non-Git data — observations — recorded boot *intent* (the moment nginx was handed an `X-Accel-Redirect`), not *delivery*, so it could report a native boot as successful while nginx was in fact returning 404. It carried real cost: React/Next/`better-sqlite3`/postcss dependency churn and an SSR surface on a boot-critical host.
	- Tracing the live boot flow showed the dynamic engine was not load-bearing. x86 k8s nodes boot entirely off the static TFTP/`menu.ipxe` tree (`nix/services/pxe-netboot.nix`); rackpi5 uses only the native-boot artifacts, which nginx already serves as files. Nothing on real hardware fetched `/api/boot` or `/api/scripts`.
	- A latent bug underlined the fragility: the publisher staged releases with `mktemp -d` (mode 0700), so the unprivileged nginx worker could not traverse into the directory and 404'd rackpi5's `boot.img`/`boot.sig`. The app-layer observation still logged "native-boot" success.
- # Decision
	- Delete the Spore application entirely — `apps/spore` (Next.js app, catalog, boot-decision engine, status UI, SQLite/drizzle, migrations, `package.nix`). Spore runs no first-party code.
	- Keep the two boring, Nix-native pieces: the static x86 iPXE tree + TFTP (`nix/services/pxe-netboot.nix`), and the signed Pi native-boot publisher, rewritten as `nix/services/spore-native-boot.nix`.
	- The publisher signs `boot.img` with `/var/lib/pi-boot-sign/private.pem` and atomically publishes `boot.img`/`boot.sig`/`nix-store.squashfs` into a world-traversable (0755) release dir. nginx serves that directory verbatim at the target's `httpPath` (`/rackpi5-ram/`), matching the EEPROM's `HTTP_PATH` — no application, `X-Accel-Redirect`, or digest routing.
	- Signed secure boot is retained (not "fancy stuff" to drop): it is the difference between trusted netboot and anyone on the lab VLAN handing the Pi a root filesystem, and its cost is now one directory's permissions.
	- Observations are dropped. "Who booted what" comes from nginx access logs, which log actual delivery (including 404s); spore already runs the nginx Prometheus exporter.
- # Consequences
	- No process, database, or Node/React/postcss dependency on a boot-critical host; far less Renovate churn and attack surface. `spore-native-boot-rackpi5.service` (name preserved) and the monitoring alerts around it stay meaningful.
	- rackpi5's EEPROM `HTTP_PATH` is `rackpi5-ram`; serving at `/rackpi5-ram/` fixed the boot without physical EEPROM access. `rackpi5.nix`'s squashfs `storeUrl` and doc comment were updated to match.
	- The signed-artifact model and matched boot.img/squashfs pairing from [[ADR/0008 Diskless netboot for rackpi5]] are unchanged; only the serving path and the deleted app differ.
	- No per-request boot policy or observation history exists. Given a handful of Nix-imaged machines, that capability is not worth an application; if richer dynamic matching is ever needed, revisit rather than resurrect the catalog.
- # Links
	- [[ADR/0013 Git and Nix own the Spore boot catalog]], [[ADR/0008 Diskless netboot for rackpi5]], [[ADR/0001 GitOps apply model]], [[Hosts/spore]], [[Hosts/rackpi5]]
