#!/usr/bin/env bash
# Lints every PrometheusRule both clusters deploy, and runs the unit tests
# written beside them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# One directory per overlay: a per-cluster patch makes two rules with one
# metadata.name, and a shared directory would keep only the last one written.
for overlay in clusters/folly/monitoring clusters/offsite/monitoring; do
  site="$(basename "$(dirname "$overlay")")"
  mkdir -p "$WORK/$site"
  rendered="$WORK/$site.rendered"
  kubectl kustomize "$overlay" >"$rendered"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    yq eval-all "select(.kind == \"PrometheusRule\" and .metadata.name == \"$name\") | {\"groups\": .spec.groups}" \
      "$rendered" >"$WORK/$site/$name.yaml"
  done < <(yq eval-all '[select(.kind == "PrometheusRule") | .metadata.name] | .[]' "$rendered")
  rm -f "$rendered"
done

if [ -z "$(find "$WORK" -name '*.yaml' -print -quit)" ]; then
  printf 'No PrometheusRule rendered from either monitoring overlay.\n' >&2
  exit 1
fi

promtool check rules "$WORK"/*/*.yaml

# promtool resolves `rule_files` relative to the test file, so each test is
# copied beside the rendered rules. A base test runs against both clusters.
for dir in "$WORK"/*/; do
  site="$(basename "$dir")"
  cp clusters/base/monitoring/*_test.yaml "$dir"
  for test_file in clusters/"$site"/monitoring/*_test.yaml; do
    if [ -e "$test_file" ]; then cp "$test_file" "$dir"; fi
  done
  (cd "$dir" && promtool test rules ./*_test.yaml)
done
