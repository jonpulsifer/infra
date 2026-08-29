#!/usr/bin/env bash
# Lints every PrometheusRule both clusters actually deploy, and runs the unit
# tests written beside them.
#
# A PrometheusRule is applied whether or not its expression matches anything,
# and a rule that matches nothing looks exactly like a fleet with nothing
# wrong. promtool is the only thing that reads these expressions before
# Prometheus does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Rendered rather than read from disk: base/monitoring reaches both clusters
# through their overlays, and only the rendered stream says what each one ends
# up with. A rule shared by both is written twice with the same content.
for overlay in clusters/folly/monitoring clusters/offsite/monitoring; do
  rendered="$WORK/rendered.yaml"
  kubectl kustomize "$overlay" >"$rendered"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    yq eval-all "select(.kind == \"PrometheusRule\" and .metadata.name == \"$name\") | {\"groups\": .spec.groups}" \
      "$rendered" >"$WORK/$name.yaml"
  done < <(yq eval-all '[select(.kind == "PrometheusRule") | .metadata.name] | .[]' "$rendered")
  rm -f "$rendered"
done

if [ -z "$(find "$WORK" -name '*.yaml' -print -quit)" ]; then
  printf 'No PrometheusRule rendered from either monitoring overlay.\n' >&2
  exit 1
fi

promtool check rules "$WORK"/*.yaml

# `rule_files` in a test is resolved relative to the test file, so the tests
# are copied next to the rules they name.
cp clusters/base/monitoring/*_test.yaml "$WORK"/
cd "$WORK"
promtool test rules ./*_test.yaml
