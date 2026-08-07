icon:: ⛵
tags:: architecture

- GitHub Actions jobs that need a real machine boundary run in **skiffs** — ephemeral cloud-hypervisor microVMs, one job each, destroyed afterwards. `apps/bosun` keeps a pool of them warm. It is a peer of [[Architecture/Spindrift]], not part of it.
- ## The four nouns
	- | Noun | What it is |
	  |---|---|
	  | **skiff** | one microVM serving exactly one job, then halting |
	  | **bosun** | the daemon that keeps skiffs alive, and the project |
	  | **hull** | the immutable kernel + initrd + manifest a skiff boots from |
	  | **class** | what a `runs-on:` label resolves to — which hull, how many vCPUs, how much memory |
	- GitHub owns `runner`, `job`, `workflow` and `label`; those words appear in YAML this project does not control, so they are never reused for anything here.
- ## Warm pool, not dispatch
	- A JIT-registered runner is ephemeral by construction: it runs one job, deregisters itself, and exits. So bosun keeps N skiffs booted and registered, and **GitHub hands one a matching job unprompted**.
	- The consequence is what makes this small: **bosun never learns that a job was queued.** There is no webhook endpoint, no queue listener, no inbound connectivity, and nothing to replay. It notices a skiff halted — the VMM exits 0, which is a `wait(2)` on a child — and boots a replacement.
	- Named cost: idle skiffs hold RAM, and there is no scale-to-zero.
- ## The hull contract is the seam
	- A hull is a directory holding a `hull.json` beside its artifacts, declaring `kernel`, `initrd`, `cmdline`, and an optional `devices[]` list. bosun reads the manifest and translates it to cloud-hypervisor arguments; it carries **no per-hull-family branching** and never learns what any device means.
	- bosun promises every skiff the same three things regardless of hull — a credential at a contract-fixed location, a writable workspace, and outbound network — plus its own identity appended to the cmdline as `bosun.skiff` and `bosun.hull`. Those are correlation facts, never claims: a guest reporting its own hull digest proves nothing to anyone.
	- A hull promises to boot from what it declared, find its credential, run one job, and halt. The last clause is enforced by GitHub rather than by anyone here.
	- Hull identity is a **content digest** over the manifest and the files it names — not a Nix store path, so a hull built without Nix can have one too.
- ## The NixOS hull
	- `nix/images/hull-nixos.nix`, built with `nix build .#hull-nixos`. It is a fleet registry entry like any other image, so it needs no special flake plumbing.
	- It carries **no rootfs**: `/` is tmpfs, and the host's `/nix/store` arrives read-only over virtiofs with a tmpfs overlay on top, so `nix build` still works in the guest. Everything the skiff runs is already on the host.
	- That store arrives with no Nix database — the host's is unreadable by an unprivileged virtiofsd — so the closure's registration rides the kernel cmdline and is loaded before `sysinit.target`. The warm-store benefit is bounded by what the hull declares in its closure; paths outside it are visible but unregistered, so Nix substitutes them as it would anywhere.
	- A skiff runs its job as root. The VM boundary is the isolation, not the user boundary inside it.
- ## Credential handling
	- bosun mints a JIT config **immediately before boot** and never stockpiles: an unused one expires about an hour after it is minted.
	- It arrives on a per-skiff virtiofs share rather than the kernel cmdline, which is world-readable inside the guest. bosun **deletes it host-side** the moment GitHub reports the runner online — virtiofs passes through to the host filesystem, so it vanishes in-guest with no cooperation from the guest, and untrusted job code never sees a live credential.
	- bosun polls **one runner id at a time and never the runner list**. A registration that no skiff ever consumes leaves a ghost behind, so the list is never the source of truth for pool size; local bookkeeping is. That one call also distinguishes a booted-*idle* skiff from a booted-*busy* one, which is invisible from the host, and catches a wedged guest — which `ch-remote ping` cannot, because a hung guest with a live VMM answers ping.
- ## Egress
	- The policy is inverted from the obvious one: **deny the LAN, allow the internet.** Every job in this repo already fetches many public hosts, and none needs a LAN destination.
	- It is a single `IPAddressDeny` on bosun's own systemd unit. systemd's IP filtering inherits down the whole cgroup subtree, so one directive covers every skiff with no per-skiff rule anywhere.
	- Denying RFC1918 breaks DNS, so a public resolver is pinned and the deny stays absolute.
- ## State
	- One directory per skiff under `/run`, holding the runner id and the hull digest. `/run` is tmpfs, so a reboot clears it, which is correct — there is no database.
	- Orphaned VMMs cannot exist: systemd's default `KillMode=control-group` takes the whole cgroup down with the unit. That also means **a bosun restart fails every in-flight job**, so a `nixos-rebuild switch` kills running CI on that host.
	- Because a cgroup kill leaves no chance to run teardown, bosun sweeps on start and deregisters what it finds.
- ## Where it runs
	- [[Fleet/riptide]] enables `services.bosun`. It shares the box with kubelet.
	- Nothing about the module is host-specific; another host imports it with only its class definitions differing.
	- ARC keeps serving `folly`, `offsite` and `self-hosted` throughout. A skiff never claims those labels — its class name is its only label.
- ## Trying it
	- `.github/workflows/skiff-smoke.yml` is a `workflow_dispatch` job on `runs-on: skiff-nixos`. It asserts what a skiff does differently: the warm shared store, the writable overlay, `nix-ld` resolving the FHS interpreter downloaded release binaries ask for, and socket-activated Docker.
	- Inspect a host with `systemctl status bosun` and `journalctl -u bosun`; each skiff's serial console is written under the module's `logDir`.
