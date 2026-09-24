---
name: kubernetes-gitops
description: >-
  Change or inspect Kubernetes state on the folly and offsite clusters through
  Flux. Use when editing anything under clusters/, forcing a Flux sync, or
  finding why a merged manifest has not taken effect.
metadata:
  runbook: docs/runbooks/apply-a-kubernetes-change.md
  wiki: https://wiki.lolwtf.ca/runbooks/apply-a-kubernetes-change/
---

# Kubernetes GitOps

The procedure is `docs/runbooks/apply-a-kubernetes-change.md`. The platform
page is `docs/platform/kubernetes.md`. These notes cover what an agent needs
beyond them.

## Notes

- Pass `--context folly` or `--context offsite` to every `kubectl` and `flux`
  command. For a kubectl plugin such as `cnpg`, put `--context` after the
  plugin name.
- Each cluster's root sync is the `FluxInstance` in
  `clusters/<site>/bootstrap/flux-values.yaml`, which an OpenTofu root applies.
  Its source is the `GitRepository` named `infra`.
- Force a sync with
  `flux --context <site> -n flux-system reconcile kustomization <name> --with-source`,
  or with `flux --context <site> -n flux-system reconcile source git infra`.
  Then make sure the revision moved in `flux --context <site> get sources git -A`.
  Without the source, a Kustomization reconcile re-applies the old revision
  and reports success.
- If a HelmRelease did not upgrade after its Kustomization applied, run
  `flux --context <site> reconcile helmrelease <name> -n <namespace>`. A
  change to a `valuesFrom` source is one cause.
- `kubectl kustomize` skips Flux's `postBuild` substitution. In Flux, an
  undefined `${VAR}` becomes empty, and a `${...}` that envsubst cannot parse
  fails the Kustomization. Escape a literal as
  `$${...}`, or annotate the resource
  `kustomize.toolkit.fluxcd.io/substitute: disabled`.
  `flux build kustomization` with cluster access runs Flux's substitution.
- A Flux Kustomization substitutes only from the sources in its
  `postBuild.substituteFrom`. Make sure the parent lists `cluster-settings`,
  `cluster-topology` or `cluster-secrets` before you use one of their keys.
- Kustomization Ready, HelmRelease Ready and pods Running are three separate
  states. Check all three before you call a change live, and check the other
  cluster when the file is under `clusters/base/`.
- To remove a Flux Kustomization, delete its `Kustomization` object from git.
  Deleting only its `path` fails the Kustomization and leaves everything it
  applied in place.
- SOPS encrypts only the `data` and `stringData` values of
  `clusters/**/*.sops.yaml`. Read key names from the encrypted file, and never
  print a decrypted value.
- Argo CD runs on folly only. Git declares no Argo `Application`. The kthx
  engine can create them in `argo`.
- Postgres is CloudNativePG. Reach a database with
  `kubectl cnpg psql <cluster> -n <namespace> --context <site>`.
  `docs/runbooks/operate-postgres.md` has the rest.
- For a change under `clusters/base/`, also use the `multi-cluster` skill.
