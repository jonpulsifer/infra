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

Examples:

```bash
kustomize build k8s/clusters/folly/kro
kustomize build k8s/clusters/folly/sandbox
```

If `kustomize build` fails with YAML errors, common causes: unquoted `:` inside plain scalars (e.g. CEL ternaries `? a : b` in manifests—wrap the whole value in double quotes).

For GitOps behaviour, SOPS, and Flux, see the `kubernetes-gitops` skill.

CI also runs Terraform validation on changed modules and Trivy on `k8s/**` and `.tf`; local commands above catch most merge-blocking issues faster.
