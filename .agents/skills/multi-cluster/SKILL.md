---
name: multi-cluster
description: Add or modify shared resources across folly and offsite k8s clusters using the base/ pattern.
---

## Shared Base Pattern

`k8s/clusters/base/` holds resources shared by both clusters. Each shared component is a directory with its own `kustomization.yaml`.

```
k8s/clusters/base/
├── kustomization.yaml              # cluster-runtimeclass
├── monitoring/
│   ├── kustomization.yaml
│   └── vector.yaml                 # ${CLUSTER_NAME} templated
└── networking/
    ├── cert-manager/
    │   ├── kustomization.yaml
    │   └── helm-release.yaml
    ├── external-dns/
    │   ├── kustomization.yaml
    │   └── helm-release.yaml       # ${CLUSTER_NAME}, ${SECRET_DOMAIN} templated
    └── tailscale/
        ├── kustomization.yaml
        └── helm-release.yaml
```

## Adding a New Shared Resource

1. Create `k8s/clusters/base/<category>/<component>/kustomization.yaml` listing the resource files
2. Templatize cluster-specific values with `${CLUSTER_NAME}`, `${SECRET_DOMAIN}`, or other vars from `cluster-settings`/`cluster-secrets`
3. In each cluster's kustomization, reference the base directory:
   ```yaml
   resources:
     - ../../../base/networking/<component>
   ```
4. Add cluster-specific patches in the overlay kustomization if needed
5. Validate both clusters:
   ```bash
   kubectl kustomize k8s/clusters/folly/<category>/
   kubectl kustomize k8s/clusters/offsite/<category>/
   ```

## Key Constraints

- **Never reference individual files** outside the kustomization root — kustomize blocks this. Always reference directories.
- **Flux postBuild substitution** handles variable replacement at deploy time. Variables come from:
  - `cluster-settings` ConfigMap (CLUSTER_NAME, TIMEZONE, network CIDRs, etc.)
  - `cluster-secrets` Secret (SECRET_DOMAIN, CLOUDFLARE_ZONE, GATEWAY_ZONE, etc.)
- The Flux Kustomization must have `postBuild.substituteFrom` configured to use templated vars.

## Shared via Flux Path References

Some resources are shared by pointing offsite's Flux Kustomization at folly's directory:

| Resource                  | Flux Kustomization path              |
|---------------------------|--------------------------------------|
| HelmRepository sources    | `./k8s/clusters/folly/sources`       |
| Sandbox apps              | `./k8s/clusters/folly/sandbox`       |
| External Secrets Operator | `./k8s/clusters/folly/external-secrets-operator` |
| External Secrets          | `./k8s/clusters/folly/external-secrets` |

This works because Flux resolves paths relative to the git repo root, not the kustomization file.

## What Stays Cluster-Specific

- `cilium/` — different BGP peers, IP pools, hubble config
- `gateway-api/` — different listeners and routes
- `tailscale/connector.yaml` — different names, routes, tags
- `cloudflare/` SOPS secrets — different tunnel credentials
- `cert-manager/issuers/` and `certificates/` — may have domain-specific diffs
