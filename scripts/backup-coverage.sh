#!/usr/bin/env bash
# Lists every PersistentVolumeClaim on a cluster with how it is backed up, and
# fails when one has no backup and no entry in scripts/backup-coverage.exclusions.
# `mise run backup:coverage [context]`; the context defaults to folly.
set -euo pipefail

readonly CTX=${1:-folly}
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly DIR
readonly EXCLUSIONS=$DIR/backup-coverage.exclusions

pvcs=$(kubectl --context "$CTX" get pvc -A -o json)
covered=$(kubectl --context "$CTX" get pods -A -o json | jq -c '
  [.items[] | . as $p
    | (($p.metadata.annotations["backup.velero.io/backup-volumes"] // "") | split(",")) as $names
    | $p.spec.volumes[]? | select(.persistentVolumeClaim and (.name | IN($names[])))
    | "\($p.metadata.namespace)/\(.persistentVolumeClaim.claimName)"] | unique')

rows=$(jq -r --argjson velero "$covered" --rawfile excl "$EXCLUSIONS" '
  ($excl | split("\n") | map(select(length > 0 and (startswith("#") | not))
    | split("\t") | {key: .[0], value: .[1]}) | from_entries) as $skip
  | .items[]
  | "\(.metadata.namespace)/\(.metadata.name)" as $k
  | [$k,
     (if .metadata.labels["cnpg.io/cluster"] then "cnpg"
      elif ($velero | index($k)) then "velero"
      elif $skip[$k] then "excluded: \($skip[$k])"
      else "UNCOVERED" end)]
  | @tsv' <<<"$pvcs")

column -t -s $'\t' <<<"$rows"
! grep -q $'\tUNCOVERED$' <<<"$rows"
