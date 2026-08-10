# bosun

bosun keeps a warm pool of "skiffs" — ephemeral cloud-hypervisor microVMs,
each serving exactly one GitHub Actions job before halting. It is a peer of
`apps/spindrift`, not part of it.

Each class in config gets a fixed number of warm skiffs. A skiff is a
JIT-registered GitHub Actions runner: GitHub hands an already-booted skiff a
matching job unprompted, so bosun never dispatches anything and never listens
for inbound traffic. bosun mints a JIT runner config immediately before boot,
launches virtiofsd/passt/cloud-hypervisor for the microVM, and polls the
runner's GitHub status to know when to revoke the credential, detect a
wedged guest, and recycle the skiff once its class's `maxLifetime` (measured
from when the job started, not from boot) runs out.

A hull is a directory holding `hull.json` plus the kernel and initrd it
names. bosun carries no branching per hull family; it only translates the
manifest into cloud-hypervisor argv, and computes the hull's digest itself
from hull.json plus the files it names.

On SIGTERM bosun drains rather than dies: idle skiffs are scuttled
registration-first (GitHub refuses to delete a busy runner, so a successful
delete proves no job can land on one mid-drain), busy skiffs get
`drainTimeout` (default 15m) to finish their job, and whatever remains at the
deadline is killed and counted under the `drained` exit reason. A stop — and
so a deploy — blocks for up to that long.

## Build and test

```
cd apps/bosun
go build ./...
go vet ./...
go test ./...
```

Tests run without KVM, network, or a real GitHub API — the GitHub calls and
process launches are both behind small interfaces with fakes in `*_test.go`.

## Config

Path given via `-config`. Example:

```json
{
  "repo": "jonpulsifer/infra",
  "tokenFile": "/run/secrets/bosun-github-token",
  "runtimeDir": "/run/bosun",
  "logDir": "/var/log/bosun",
  "workspaceDir": "/var/lib/bosun/workspace",
  "pollInterval": "30s",
  "drainTimeout": "15m",
  "classes": {
    "skiff-nixos": {"hull": "/nix/store/...-hull-nixos", "vcpus": 4, "memory": "4096M", "warm": 1, "maxLifetime": "1h"},
    "skiff-ubuntu": {"hull": "/nix/store/...-hull-ubuntu", "vcpus": 4, "memory": "3072M", "workspace": "6G", "warm": 2, "maxLifetime": "1h"}
  }
}
```

`runtimeDir` (default `/run/bosun`) is bosun's entire runtime state — it is
`/run`, so a reboot clears it and there is no database. The class name is
the label a workflow's `runs-on:` matches against; it must never be
`self-hosted`, which the existing ARC runners use, and LoadConfig rejects a
class named that.

A class's `workspace` sizes a scratch disk, reserved under `workspaceDir` at
boot and deleted with the skiff. Without one, both hull families put the guest
root on a tmpfs overlay and `memory` is the class's disk budget too, so a
checkout that outgrows it is an OOM rather than an ENOSPC. The disk is handed
over raw and appended after every hull-declared device, with its guest device
name on the kernel cmdline as `bosun.workspace=` — what filesystem it carries
is the hull's business, and bosun never learns what was written to it.

`bin.cloudHypervisor` / `bin.virtiofsd` / `bin.passt` override the binaries
bosun execs; unset ones resolve from `PATH`.

## Benchmarks

Measured 2026-08-09/10 on this repo's real CI suite (the `TypeScript`
workflow's lint/typecheck/build/test against a live Postgres), via
`.github/workflows/typescript-benchmark.yml`. The skiff host was `tender`, a
GCE c4-standard-8 Spot instance (Granite Rapids, nested virtualization);
`skiff-ubuntu` is 4 vCPU / 3 GiB RAM / 6 G workspace disk per skiff, and the
same hull the lab hosts boot.

### Benchmark job wall clock — five waves, same commit

| wave | caches | skiff-ubuntu | ubuntu-latest | infra-offsite (ARC) |
| ---- | ------ | ------------ | ------------- | ------------------- |
| 1 | best | **230 s** | 338 s | 503 s |
| 2 | best | **225 s** | 69 s¹ | 250 s |
| 3 | best | **229 s** | 85 s¹ | 217 s |
| 4 | none | **222 s** | 334 s | 430 s |
| 5 | none | **228 s** | 335 s | 399 s |

¹ Same-sha artifact: the GHA turbo cache memoized this exact commit between
waves, which a fresh commit never benefits from. Hosted's realistic wall is
334–338 s.

The skiff's spread across five runs on five different slots was **8 s**.
Queue-to-start was **1 s on every run** (hosted 2–8 s, ARC pod 1–59 s). The
Build step alone: 16–17 s on the skiff, 23–26 s hosted, 22–71 s ARC.

### The cold path (`caches: none`) — does 3 GiB hold?

| step | skiff-ubuntu (2.9 GiB RAM) | ubuntu-latest (15.6 GiB) |
| ---- | -------------------------- | ------------------------ |
| acquisition | 2 s | 8 s |
| Set up Helm (mise, cold) | 88 s | 6 s |
| Install dependencies | 16 s | 4 s |
| Build | 25 s | 25 s |
| Test | 270 s | 244 s |

An 11% Test deficit and an identical Build on a fifth of the memory. The one
real cold-start cost is the mise toolchain download, paid once per workspace
slot lifetime.

### The local actions/cache service

`services.bosun.cache` runs a cache-API service on the host's own disk; the
Ubuntu hull patches the runner so the stock `actions/cache` action talks to
it transparently (`ACTIONS_RESULTS_URL` via `bosun.cache=` on the cmdline).
Measured on tender with the suite's 614 MB bun store:

| | local service | GitHub's cache service |
| --- | ------------- | ---------------------- |
| restore (hit) | **14 s** | 49–76 s (self-hosted labels) |
| save (once) | 54 s | comparable |
| benchmark wall on a hit | **73 s** | 334–338 s hosted realistic |

73 s through the stock cache path equals a hosted runner's best same-sha
case — and a workflow migrated onto a skiff label gets it with no workflow
changes at all.

### The build-backend bench — GHA hosted, Cloud Build, and the pool

Measured 2026-08-10, after tender's return, via
`.github/workflows/container-benchmark.yml` and the TypeScript benchmark's
`skiff-ubuntu-xl` label (tender-pinned: 4 vCPU / 3 GiB / 20 G disk —
`skiff-ubuntu` can land on a 2-vCPU host, which is not the size-matched
comparison). The container workload is one cold build of
`apps/spindrift/Dockerfile` — `--no-cache --pull`, dockerd's embedded
BuildKit on every backend, `docker system prune -af` first so a persisting
skiff cannot smuggle warm layers. Cloud Build ran the same build from
GCS-staged source, timed by the Build resource's own clock (machine time,
in-cloud fetch included, queue excluded); GCB has no 4-vCPU point, so both
its default machine and `e2-highcpu-8` are shown.

| backend | cores/RAM | cold image build (3 runs) |
| --- | --- | --- |
| GHA hosted `ubuntu-latest` | 4 / 16 GiB | **25, 28, 25 s** |
| Cloud Build `e2-highcpu-8` | 8 / 8 GiB | 33, 34, 35 s |
| skiff-ubuntu-xl (tender) | 4 / 3 GiB | 34, 36, 37 s |
| Cloud Build default | 2 / 8 GiB | 48, 51, 55 s |

A cold image build is registry-bound, and that is the whole table: hosted
sits closest to the registries, Cloud Build needs twice the cores to match a
skiff pulling through passt over GCE's network, and nobody is CPU-bound.

The same session's TypeScript suite, same commit, one wave per row:

| caches | skiff-ubuntu-xl | ubuntu-latest |
| --- | --- | --- |
| none (cold, network-isolated) | **294 s** (Test 204 s) | 325 s (Test 231 s) |
| best, first run (populating) | **305 s** (Test 206 s) | 388 s (Test 288 s) |
| best, warm steady state | **57 s** | 66 s |

The xl class repeats the plain class's result on 3 GiB against hosted's
16 GiB: the suite is CPU-and-database-bound, tender's Test step holds a
±1 s spread (204–206 s) where hosted swings 231–288 s, and the warm-slot
steady state — the number a developer actually feels on push — is under a
minute on both, with the skiff ahead. One wave was discarded with cause:
both labels failed "Initialize containers" simultaneously, a registry
hiccup fetching the Postgres service image, which is not a runner property.
