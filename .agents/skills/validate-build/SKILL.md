---
name: validate-build
description: >-
  Verify this repo builds and validates cleanly before commit: Kustomize
  overlays. Use after editing k8s/
---

## Environment

Tools come from the flake. Prefer the dev shell so `kustomize`, `terraform`, etc. are on `PATH`:

```bash
nix develop
```

## Kubernetes / Kustomize

Build the **kustomization root that includes your change** (the directory with `kustomization.yaml` that lists your file, or a parent Flux kustomization).

Use `kubectl kustomize` (kustomize is not a standalone binary in this flake):

```bash
kubectl kustomize k8s/clusters/folly/sandbox
kubectl kustomize k8s/clusters/offsite/monitoring
```

When validating shared base changes, build **both** clusters since both reference `k8s/clusters/base/`:

```bash
for cluster in folly offsite; do
  kubectl kustomize "k8s/clusters/$cluster/networking/cert-manager/" && echo "OK: $cluster"
done
```

If `kubectl kustomize` fails with YAML errors, check for unquoted `:` inside plain scalars.

**Important:** Kustomize cannot reference individual files outside the kustomization root. Shared resources in `base/` must be directories with their own `kustomization.yaml`, referenced as directory paths (not file paths).

For GitOps behaviour, SOPS, and Flux, see the `kubernetes-gitops` skill.

CI also runs Terraform validation on changed modules and Trivy on `k8s/**` and `.tf`; local commands above catch most merge-blocking issues faster.
