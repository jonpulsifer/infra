# k6-scripts

Type definitions and a typecheck for the k6 load-test scripts in `clusters/folly/apps/k6/scripts/`. [Observability](https://wiki.lolwtf.ca/platform/observability/) covers what the tests check and how a failure alerts.

## Develop

```bash
bun run --cwd packages/k6 typecheck
```

k6 runs TypeScript directly. It is not in `mise.toml`, so install k6 to run a script locally. A script reads its target URLs from `TARGET_*` environment variables:

```bash
TARGET_APP_URL=https://... TARGET_CONTROL_PLANE_URL=https://... TARGET_EDGE_URL=https://... \
  k6 run clusters/folly/apps/k6/scripts/scenarios.ts
```

## Deploy

The `configMapGenerator` in `clusters/folly/apps/k6/kustomization.yaml` packs each listed script into the `k6-scenarios` ConfigMap, and Flux applies it on folly. Add a new script to that list. A daily CronJob recreates the k6-operator TestRun, which sets the `TARGET_*` URLs.
