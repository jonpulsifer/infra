# k6

Typecheck shell for the k6 scenario scripts that live beside their platform
declarations in `clusters/folly/apps/k6/scripts/`.

The k6-operator on folly runs them: a Flux-declared CronJob recreates the
`scenarios` TestRun on schedule, the runner pushes metrics to the cluster's
Prometheus (`k6 Prometheus` dashboard in Grafana), and a breached threshold
fails the runner Job, which reaches Discord through the stock KubeJobFailed
alert.

Run a script locally with the `TARGET_*` env vars it reads — k6 executes
TypeScript natively:

```shell
TARGET_APP_URL=https://... k6 run clusters/folly/apps/k6/scripts/scenarios.ts
```
