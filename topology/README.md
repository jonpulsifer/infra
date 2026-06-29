# `topology/` — network single source of truth

`topology.json` is the canonical declaration of homelab **network facts** — cluster
IP addresses, CIDRs, the API-server endpoints, BGP ASNs, and the BGP gateway/neighbor
addresses. It exists because these values were previously restated across every layer
(NixOS, Kubernetes/Flux, Terraform) in different syntaxes, so a single change meant
hand-editing the same address in four or five files and drift was inevitable.

Edit `topology.json` and the value flows to every consumer. **Do not hand-edit the
generated/derived values elsewhere.**

## Files

| File | Purpose |
|---|---|
| `topology.json` | The source of truth. Network facts only. |
| `schema.json` | JSON Schema for `topology.json` (validation / editor hints). |
| `generate.sh` | Renders the Flux `cluster-settings` ConfigMaps from `topology.json`. |
| `README.md` | This file. |

## Consumers

- **Nix** — `nix/services/k8s/networks.nix` reads `topology.json` via
  `builtins.fromJSON` and projects it onto the attribute shape
  `nix/services/k8s/default.nix` expects.
- **Flux / Kubernetes** — `topology/generate.sh` writes
  `clusters/<site>/config/cluster-settings.yaml` (committed). Flux substitutes those
  `${VAR}`s into manifests via `postBuild.substituteFrom`; it cannot read `topology.json`
  directly, which is why the ConfigMap is generated and committed. Operational, non-network
  knobs (timezone, cert issuer) live in `clusters/<site>/config/cluster-settings.operational.env`
  and are merged in by the generator.
- **Terraform** — roots read `topology.json` with
  `jsondecode(file("${path.module}/../../../topology/topology.json"))` (relative depth
  varies per root) and reference `local.topology.clusters.<site>.<field>`.

## Workflow

```bash
# after editing topology.json (or an operational.env):
topology/generate.sh            # rewrite the committed cluster-settings ConfigMaps
git add -A && git commit ...

# CI / pre-commit drift guard (fails if a committed file is stale):
topology/generate.sh --check
```

When changing a cluster network value, also run the per-layer validation
(`nix flake check`, `terraform validate`, `kustomize build clusters/<site>/config`) and
confirm the Atlantis plan shows **no resource diff** — every derived value must equal the
literal it replaced.
