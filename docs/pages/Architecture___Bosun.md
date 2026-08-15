icon:: ⛵
tags:: architecture

- GitHub Actions jobs that need a real machine boundary run in **skiffs** — ephemeral cloud-hypervisor microVMs, one job each, destroyed afterwards. `apps/bosun` keeps a pool of them warm. It is a peer of [[Architecture/Spindrift]], not part of it.
- ## The four nouns
	- | Noun | What it is |
	  |---|---|
	  | **skiff** | one microVM serving exactly one job, then halting |
	  | **bosun** | the daemon that keeps skiffs alive, and the project |
	  | **hull** | the immutable kernel + initrd + manifest a skiff boots from |
	  | **class** | what a `runs-on:` label resolves to — which hull, how many vCPUs, how much memory and scratch disk |
	- GitHub owns `runner`, `job`, `workflow` and `label`; those words appear in YAML this project does not control, so they are never reused for anything here.
- ## Warm pool, not dispatch
	- A JIT-registered runner is ephemeral by construction: it runs one job, deregisters itself, and exits. So bosun keeps N skiffs booted and registered, and **GitHub hands one a matching job unprompted**.
	- The consequence is what makes this small: **bosun never learns that a job was queued.** There is no webhook endpoint, no queue listener, no inbound connectivity, and nothing to replay. It notices a skiff halted — the VMM exits 0, which is a `wait(2)` on a child — and boots a replacement.
	- That replacement is the fast path, not the guarantee. Every poll tick also **reconciles each class against its warm count** and boots what is missing, because a spawn can fail — a mint that 5xx'd, a workspace that would not fit — and a class one slot short otherwise stays that way for the life of the process, serving at half its declared depth and looking exactly like a class that works. A class that keeps failing to boot backs off rather than minting a registration every tick forever.
	- Named cost: idle skiffs hold RAM, and there is no scale-to-zero.
- ## The Spindrift build source
	- `services.bosun.spindrift` turns a host into a second, independent work source alongside its GitHub warm pool: bosun long-polls [[Architecture/Spindrift]]'s outbox instead of waiting for GitHub to hand a registered skiff a job.
	- `apps/bosun/spindrift.go` claims, heartbeats, and posts results against `apps/spindrift/src/web/bosun-route.ts`'s three bearer-authed `/internal/bosun/` endpoints — the same shared secret authenticates all three, because a bosun host cannot hold a browser session the way every other caller of that process does.
	- A claim boots a build-hull skiff (`nix/images/hull-build-ubuntu.nix`) with the opaque request document written into its share where a JIT config would otherwise go, instead of registering it against GitHub. A class serving builds sets `warm = 0`: a build skiff boots on claim rather than ahead of time, so keeping one warm buys nothing.
	- This is one of Spindrift's own build routes — see [[Architecture/Spindrift]] for the other three and how rank among them is decided.
- ## The hull contract is the seam
	- A hull is a directory holding a `hull.json` beside its artifacts, declaring `kernel`, `initrd`, `cmdline`, and an optional `devices[]` list. bosun reads the manifest and translates it to cloud-hypervisor arguments; it carries **no per-hull-family branching** and never learns what any device means.
	- bosun promises every skiff the same four things regardless of hull — a credential at a contract-fixed location, a writable workspace, outbound network, and a writable diagnostic share on the host — plus its own identity appended to the cmdline as `bosun.skiff` and `bosun.hull`. Those are correlation facts, never claims: a guest reporting its own hull digest proves nothing to anyone.
	- A hull promises to boot from what it declared, find its credential, run one job, and halt. The last clause is enforced by GitHub rather than by anyone here.
	- Hull identity is a **content digest** over the manifest and the files it names — not a Nix store path, so a hull built without Nix can have one too.
- ## The NixOS hull
	- `nix/images/hull-nixos.nix`, built with `nix build .#hull-nixos`. It is a fleet registry entry like any other image, so it needs no special flake plumbing.
	- It carries **no rootfs**: `/` is tmpfs, and the host's `/nix/store` arrives read-only over virtiofs with a tmpfs overlay on top, so `nix build` still works in the guest. Everything the skiff runs is already on the host.
	- That store arrives with no Nix database — the host's is unreadable by an unprivileged virtiofsd — so the closure's registration rides the kernel cmdline and is loaded before `sysinit.target`. The warm-store benefit is bounded by what the hull declares in its closure; paths outside it are visible but unregistered, so Nix substitutes them as it would anywhere.
	- A skiff runs its job as root. The VM boundary is the isolation, not the user boundary inside it.
- ## Authenticating to GitHub
	- bosun mints its own JIT configs and skiff registrations as an installation of the shared Spindrift+bosun GitHub App — see [[Architecture/Spindrift]]. `services.bosun.github.appId` and `.privateKeyFile` (`apps/bosun/module.nix`) name the App id and bosun's own private key; `apps/bosun/github.go` signs the JWT and narrows every mint to `administration:write`, resolving the installation per repository.
	- bosun and Spindrift hold the **same** private key on that App today — the operator's choice, not a code constraint: GitHub Apps support a distinct key per consumer, but this fleet rotates one PEM for both. That key lives in `nix/secrets/bosun.sops.yaml`, shared by every bosun host rather than duplicated per host; see [[Architecture/Secrets and PKI]].
- ## Credential handling
	- bosun mints a JIT config **immediately before boot** and never stockpiles: an unused one expires about an hour after it is minted.
	- It arrives on a per-skiff virtiofs share rather than the kernel cmdline, which is world-readable inside the guest. bosun **deletes it host-side** the moment GitHub reports the runner online — virtiofs passes through to the host filesystem, so it vanishes in-guest with no cooperation from the guest, and untrusted job code never sees a live credential.
	- bosun polls **one runner id at a time and never the runner list**. A registration that no skiff ever consumes leaves a ghost behind, so the list is never the source of truth for pool size; local bookkeeping is. That one call also distinguishes a booted-*idle* skiff from a booted-*busy* one, which is invisible from the host, and catches a wedged guest — which `ch-remote ping` cannot, because a hung guest with a live VMM answers ping.
	- The wedge rule applies to **idle skiffs only**. Offline-with-a-live-VMM does not distinguish a hung guest from a running job whose runner went quiet, so on a busy skiff it would destroy the job and the evidence of why. A busy skiff is bounded by its class's `maxLifetime` instead, which is why that budget may not be zero.
- ## Egress
	- The policy is inverted from the obvious one: **deny the LAN, allow the internet.** Every job in this repo already fetches many public hosts, and none needs a LAN destination.
	- It is a single `IPAddressDeny` on bosun's own systemd unit. systemd's IP filtering inherits down the whole cgroup subtree, so one directive covers every skiff with no per-skiff rule anywhere.
	- Denying RFC1918 breaks DNS, so a public resolver is pinned and the deny stays absolute.
- ## State
	- One directory per skiff under `/run`, holding the runner id and the hull digest. `/run` is tmpfs, so a reboot clears it, which is correct — there is no database.
	- A skiff whose registration bosun **could not** delete leaves its directory behind holding the runner id alone, credential included in what is stripped. That id is the only handle left on a live registration, and the sweep below is the only thing that can still spend it.
	- A stop **drains** instead of failing every in-flight job. Idle skiffs are scuttled registration-first: GitHub refuses to delete a busy runner's registration, so a successful delete proves no job can land on that skiff and its VMM is safe to kill. Busy skiffs get the module's `drainTimeout` (default 15 min) to finish — which is also how long a `nixos-rebuild switch` may block on that host.
	- Orphaned VMMs still cannot exist: the unit runs `KillMode=mixed`, so the stop signal reaches the daemon alone but systemd SIGKILLs the whole cgroup at the stop timeout.
	- Because a cgroup kill leaves no chance to run teardown, bosun sweeps on start and deregisters what it finds — retrying, rather than discarding, any id whose delete fails again.
- ## Where it runs
	- [[Fleet/riptide]] enables `services.bosun`. It shares the box with kubelet.
	- Nothing about the module is host-specific; another host imports it with only its class definitions differing.
	- ARC keeps serving `folly`, `offsite` and `self-hosted` throughout. A skiff never claims those labels — its class name is its only label.
- ## Trying it
	- `.github/workflows/skiff-smoke.yml` is a `workflow_dispatch` job on `runs-on: skiff-nixos`. It asserts what a skiff does differently: the warm shared store, the writable overlay, `nix-ld` resolving the FHS interpreter downloaded release binaries ask for, and socket-activated Docker.
	- Inspect a host with `systemctl status bosun` and `journalctl -u bosun`. Under the module's `logDir`, each skiff leaves its serial console as `<id>.log`, and an Ubuntu-hull skiff also leaves the runner's own trace in `<id>.diag/` — a writable virtiofs share, so it lands on the host *while* the job runs and survives a skiff killed mid-job. bosun offers that share to every skiff; the NixOS hull does not mount it yet, so a `skiff-nixos` `<id>.diag/` is empty. Both outlive the skiff and are aged out by `logRetention`.
	- A class's `memory` is also its **disk budget** unless the class sizes a `workspace`: the whole guest root is a tmpfs overlay, so a checkout plus build that outgrows it is an OOM rather than an `ENOSPC`.
	- A `workspace` is a virtio-blk scratch disk, reserved under the module's `workspaceDir` at boot and deleted with the skiff. bosun appends it after every hull-declared device and names it on the cmdline as `bosun.workspace=`, because a device index shifts with what the hull declared and a name does not. It is handed over raw — the Ubuntu hull formats it and puts the runner's workspace and docker's data root there, which is what lets a class hold more warm skiffs than its memory alone would allow. What the disk carries is the hull's business; bosun never learns what was written to it.
	- The space is reserved up front, not as a build uses it, so `warm × workspace` per class is what the host must keep free — an overcommitted pool fails a spawn, which is visible, rather than a build mid-run, which is not.
