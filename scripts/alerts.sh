#!/usr/bin/env bash
# Lists every cluster's Alertmanager alerts through the kube-apiserver service
# proxy. `mise run alerts [filter]` keeps rows that match the filter with grep -i.
# Each clusters/<site>/ directory name is also its kubectl context.
set -euo pipefail

readonly PROXY=/api/v1/namespaces/monitoring/services/prom-stack-kube-prometheus-alertmanager:9093/proxy/api/v2/alerts
filter=${1:-}

emit() {
  local ctx=$1 json
  if ! json=$(kubectl --context "$ctx" get --raw "$PROXY" 2>&1); then
    printf 'warn: %s unreachable: %s\n' "$ctx" "${json##*$'\n'}" >&2
    return 0
  fi
  jq -r --arg ctx "$ctx" '
    def rank: {critical: 0, warning: 1, info: 2}[.labels.severity] // 3;
    sort_by(rank, .labels.alertname)[]
    | [ $ctx,
        (.labels.severity // "-"),
        .labels.alertname,
        (.labels.namespace // "-"),
        (.labels.pod // .labels.job // .labels.instance // "-"),
        .status.state,
        (.receivers | map(.name) | join(","))
      ] | @tsv' <<<"$json"
}

{
  printf 'CLUSTER\tSEV\tALERT\tNAMESPACE\tOBJECT\tSTATE\tRECEIVER\n'
  for dir in clusters/*/; do
    ctx=$(basename "$dir")
    [[ $ctx == base ]] && continue
    emit "$ctx"
  done | { grep -i -- "$filter" || true; }
} | column -t -s"$(printf '\t')"
