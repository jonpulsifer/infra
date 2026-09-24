# bosun

bosun is a Go daemon that keeps a warm pool of skiffs: cloud-hypervisor
microVMs that each run one GitHub Actions job and then halt. It is parked, and
no host enables it. See [Bosun](https://wiki.lolwtf.ca/apps/bosun/).

## Build and test

```bash
go build ./...
go vet ./...
go test -race ./...
```

The tests need no KVM, network or GitHub API. Fakes in the `*_test.go` files
replace the GitHub client and the process launcher. `-race` needs a C
toolchain. `.github/workflows/go.yml` runs these commands on each change under
`apps/bosun/`.

## Run

```bash
bosun -config config.json
```

`config.go` defines each key and its default. A minimal config:

```json
{
  "repo": "jonpulsifer/infra",
  "github": {"appId": 12345, "privateKeyFile": "/run/secrets/bosun-github-app-key"},
  "classes": {
    "skiff-nixos": {"hull": "/nix/store/...-hull-nixos", "vcpus": 4, "memory": "4096M", "warm": 1, "maxLifetime": "1h"}
  }
}
```

- Each key under `classes` is a label that a workflow's `runs-on:` matches.
  `LoadConfig` rejects `self-hosted`, which the ARC runners use.
- A hull is a directory with `hull.json` and the kernel and initrd that it
  names. `nix/images/hull-nixos.nix` and `nix/images/hull-ubuntu.nix` build
  them.
- `runtimeDir` (default `/run/bosun`) holds all runtime state. A reboot clears
  it.
- `workspace` gives a class a raw scratch disk under `workspaceDir`. Without
  one, the guest root is a tmpfs overlay and `memory` is also the disk budget.
- `bin.cloudHypervisor`, `bin.virtiofsd` and `bin.passt` override the binaries.
  Unset ones come from `PATH`.
- With `spindrift` set, bosun also polls the kthx built-apps engine for build
  requests and runs each one on a skiff.

On SIGTERM, bosun removes idle skiffs, gives busy skiffs `drainTimeout`
(default 15m) to finish their jobs, and then kills the rest. A stop can take
that long.

## Deploy

`module.nix` is the NixOS module `services.bosun`, and `package.nix` builds the
binary. No host imports the module.
