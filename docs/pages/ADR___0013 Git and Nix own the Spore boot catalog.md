status:: proposed
date:: 2026-07-19
deciders:: [[jawn]]
tags:: adr

- # Context
	- Spore decides what bare-metal hosts boot and is therefore desired infrastructure state, but its profiles, scripts, assignments, and server origin were editable through an unauthenticated web UI and stored beside runtime observations in one SQLite database.
	- Three seed formats had already diverged, including a dated Nix store path. The container also duplicated the dnsmasq and nginx services that NixOS already owns on the `spore` host.
	- [[ADR/0001 GitOps apply model]] requires reviewed desired state in Git. [[ADR/0008 Diskless netboot for rackpi5]] also makes failure isolation important: a management application failure must not take down TFTP, static HTTP assets, NFS, or nginx.
- # Decision
	- Git and Nix own Spore's immutable boot catalog. Nix derives host identities from `terraform/network/unifi/folly/clients.yaml`, adds reviewed profile/script policy from `nix/hosts/spore.nix`, validates references, and supplies the resulting JSON to the application.
	- One framework-independent boot-decision module owns MAC normalization, host/profile selection, template rendering, script chaining, and explicit outcomes. Next.js remains as a small read-only status UI and a pair of thin HTTP adapters; replacing it would not simplify the native SQLite or Nix packaging constraints in this change.
	- SQLite stores only best-effort boot observations and migration metadata. Losing that database resets observation history but cannot alter boot policy. Explicit migrations and retained `VACUUM INTO` backups replace schema push-on-start behavior.
	- Spore runs directly as a hardened, loopback-only NixOS systemd service using the standalone Next.js output and a pinned Node runtime. Docker, Supervisor, and the container-owned dnsmasq configuration are removed.
	- The existing NixOS dnsmasq/TFTP/static-nginx stack remains independent. Its default vhost exposes only the read-only iPXE boot/script adapters; the management surface is available through a separate Tailscale-authenticated vhost. The application backend port is not opened in the firewall.
- # Consequences
	- Boot-policy changes now require a reviewed PR and host rebuild, which is slower than editing a browser form but matches the repository's apply model and leaves an audit trail.
	- UniFi reservations and Spore assignments share one MAC source of truth. Catalog validation and boot tests catch malformed origins, dangling references, unsafe script paths, and policy regressions before deployment.
	- An application or observation-database failure is visible separately from the boot-critical TFTP, static HTTP, NFS, and nginx services. Static PXE assets continue to work during a Spore process failure.
	- `better-sqlite3` must be compiled for the aarch64 host with the same pinned Node ABI used at runtime. Native ARM CI proves that package and host closure.
	- The pre-migration database is preserved as a recoverable backup. Browser-authored desired state is not imported automatically; reviewed catalog state is authoritative.
- # Links
	- [[ADR/0001 GitOps apply model]], [[ADR/0008 Diskless netboot for rackpi5]], [[Architecture/Applications]], [[Architecture/NixOS]], [[Hosts/spore]]
