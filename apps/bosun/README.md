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
  "pollInterval": "30s",
  "classes": {
    "skiff-nixos": {"hull": "/nix/store/...-hull-nixos", "vcpus": 4, "memory": "4096M", "warm": 1, "maxLifetime": "1h"}
  }
}
```

`runtimeDir` (default `/run/bosun`) is bosun's entire runtime state — it is
`/run`, so a reboot clears it and there is no database. The class name is
the label a workflow's `runs-on:` matches against; it must never be
`self-hosted`, which the existing ARC runners use, and LoadConfig rejects a
class named that.

`bin.cloudHypervisor` / `bin.virtiofsd` / `bin.passt` override the binaries
bosun execs; unset ones resolve from `PATH`.
