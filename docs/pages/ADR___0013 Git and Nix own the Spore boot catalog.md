status:: accepted
date:: 2026-07-19
deciders:: [[jawn]]
tags:: adr

- # Context
	- Spore decides what bare-metal hosts boot and is therefore desired infrastructure state, but its profiles, scripts, assignments, and server origin were editable through an unauthenticated web UI and stored beside runtime observations in one SQLite database.
	- Three seed formats had already diverged, including a dated Nix store path. The container also duplicated the dnsmasq and nginx services that NixOS already owns on the `spore` host.
	- [[ADR/0001 GitOps apply model]] requires reviewed desired state in Git. [[ADR/0008 Diskless netboot for rackpi5]] makes Spore's native signed-boot target part of that reviewed state.
- # Decision
	- Git and Nix own Spore's immutable boot catalog. Nix derives host identities from `terraform/network/unifi/folly/clients.yaml`, adds reviewed profile/script policy from `nix/hosts/spore.nix`, validates references, and supplies the resulting JSON to the application.
	- One framework-independent boot-decision module owns MAC normalization, host/profile selection, template rendering, script chaining, and explicit outcomes. Next.js remains as a small read-only status UI and a pair of thin HTTP adapters; replacing it would not simplify the native SQLite or Nix packaging constraints in this change.
	- SQLite stores only best-effort boot observations and migration metadata. Losing that database resets observation history but cannot alter boot policy. Explicit migrations and retained `VACUUM INTO` backups replace schema push-on-start behavior.
	- Spore runs directly as a hardened, loopback-only NixOS systemd service using the standalone Next.js output and a pinned Node runtime. Docker, Supervisor, and the container-owned dnsmasq configuration are removed.
	- The existing NixOS dnsmasq/TFTP/static-nginx stack remains independently owned for x86 PXE clients. Its default vhost exposes the read-only iPXE adapters plus rackpi5's native signed-boot adapter; large artifacts use an internal nginx handoff rather than flowing through Node. The management surface remains on a separate restricted vhost and the application backend port is not opened in the firewall.
	- Native targets are catalog entries derived from the same UniFi MAC inventory. A root-only publisher injects the squashfs digest, signs `boot.img`, and atomically activates an immutable artifact set before Spore and nginx start.
- # Consequences
	- Boot-policy changes now require a reviewed PR and host rebuild, which is slower than editing a browser form but matches the repository's apply model and leaves an audit trail.
	- UniFi reservations and Spore assignments share one MAC source of truth. Catalog validation and boot tests catch malformed origins, dangling references, unsafe script paths, and policy regressions before deployment.
	- The x86 static PXE path remains isolated from application failures. Rackpi5 intentionally has no parallel fallback: Spore's native adapter and nginx are its sole network boot path and fail closed together.
	- `better-sqlite3` must be compiled for the aarch64 host with the same pinned Node ABI used at runtime. Native ARM CI proves that package and host closure.
	- The pre-migration database is preserved as a recoverable backup. Browser-authored desired state is not imported automatically; reviewed catalog state is authoritative.
- # Links
	- [[ADR/0001 GitOps apply model]], [[ADR/0008 Diskless netboot for rackpi5]], [[Architecture/Applications]], [[Architecture/NixOS]], [[Hosts/spore]]
