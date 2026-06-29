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
| `generate.sh` | Renders the Flux `cluster-topology` ConfigMaps from `topology.json`. |
| `README.md` | This file. |

## Consumers

- **Nix** — `nix/services/k8s/networks.nix` reads `topology.json` via
  `builtins.fromJSON` and projects it onto the attribute shape
  `nix/services/k8s/default.nix` expects.
- **Flux / Kubernetes** — `topology/generate.sh` writes the per-cluster
  `cluster-topology` ConfigMap to `clusters/<site>/config/cluster-topology.yaml`
  (committed). Each one carries two views of the same facts:
  - `data."topology.json"` — the source of truth **verbatim** (minus its editor-only
    `"$schema"` pointer). Portable: mount it as a file, or read the whole document with
    `kubectl get cm cluster-topology -n flux-system -o jsonpath='{.data.topology\.json}' | jq`.
  - flat `KEY: value` pairs — the local cluster's facts, for Flux
    `postBuild.substituteFrom` (which does `${VAR}` substitution and cannot read a JSON blob).

  It is generated and committed because Flux reads it at reconcile time and cannot read
  `topology.json` directly. The ConfigMap is listed in every Kustomization's
  `substituteFrom` (alongside `cluster-settings` and `cluster-secrets`). Operational,
  non-network knobs (timezone, cert issuer) stay in the hand-edited `cluster-settings`
  ConfigMap — the generator does not touch it.
- **Terraform** — roots read `topology.json` with
  `jsondecode(file("${path.module}/../../../topology/topology.json"))` (relative depth
  varies per root) and reference `local.topology.clusters.<site>.<field>`.

## Workflow

```bash
# after editing topology.json:
topology/generate.sh            # rewrite the committed cluster-topology ConfigMaps
git add -A && git commit ...

# CI / pre-commit drift guard (fails if a committed file is stale):
topology/generate.sh --check
```

When changing a cluster network value, also run the per-layer validation
(`nix flake check`, `terraform validate`, `kustomize build clusters/<site>/config`) and
confirm the Atlantis plan shows **no resource diff** — every derived value must equal the
literal it replaced.
