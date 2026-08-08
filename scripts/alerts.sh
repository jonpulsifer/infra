#!/usr/bin/env bash
# Firing alerts from every cluster's Alertmanager, read through the
# kube-apiserver service proxy — no port-forward, no ingress, no extra creds.
#
#   mise run alerts            # every alert, every cluster
#   mise run alerts jellyfin   # case-insensitive substring over the whole row
#
# Clusters come from clusters/*/ so a new site needs no edit here.
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
