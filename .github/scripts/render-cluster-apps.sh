#!/usr/bin/env bash
# Renders the shared app seams for both cluster adapters plus folly monitoring
# without touching live state, then templates every in-repo chart the rendered HelmReleases name,
# using the values those HelmReleases set.
#
# Rendering the kustomizations alone proves the overlays compose; it says
# nothing about whether the charts they point at can render. A chart guard
# (`{{ fail }}`) or any other template error only surfaced at Flux reconcile
# time, which is downtime rather than a red check. The values are the input
# that matters: a chart templated with its own `values.yaml` defaults would
# miss a key that only a cluster's HelmRelease declares.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

OVERLAYS=(
  clusters/folly/apps
  clusters/offsite/apps
  clusters/folly/apps/arc
  clusters/offsite/apps/arc
  clusters/folly/monitoring
)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ns/name of every HelmRelease this run actually templated, so the coverage
# check below can name the ones it never reached.
covered="$WORK/covered"
: >"$covered"

failures=0

# Extracts one field from one document of a rendered stream.
field() {
  yq eval-all "select(documentIndex == $2) | $3" "$1"
}

template_releases() {
  local rendered="$1" overlay="$2"
  local idx ns name chart source release target values
  local list="$WORK/releases-${overlay//\//_}.tsv"

  yq eval-all '
    select(.kind == "HelmRelease")
    | [[ documentIndex,
         (.metadata.namespace // "default"),
         .metadata.name,
         (.spec.chart.spec.chart // "-"),
         (.spec.chart.spec.sourceRef.kind // .spec.chartRef.kind // "unknown source") ]]
    | @tsv
  ' "$rendered" >"$list"

  while IFS=$'\t' read -r idx ns name chart source; do
    [ -n "${idx:-}" ] || continue

    if [ "$chart" = "-" ]; then
      printf '  skipped %s/%s — chartRef (%s), chart not in this repo\n' \
        "$ns" "$name" "$source"
      continue
    fi

    if [ ! -f "$chart/Chart.yaml" ]; then
      printf '  skipped %s/%s — chart %q from %s, not in this repo\n' \
        "$ns" "$name" "$chart" "$source"
      continue
    fi

    release="$(field "$rendered" "$idx" '.spec.releaseName // .metadata.name')"
    target="$(field "$rendered" "$idx" '.spec.targetNamespace // .metadata.namespace // "default"')"
    values="$WORK/values-$ns-$name.yaml"
    field "$rendered" "$idx" '.spec.values // {}' >"$values"

    printf '%s/%s\n' "$ns" "$name" >>"$covered"

    # Flux substitutes ${VAR} postbuild variables from cluster ConfigMaps and
    # Secrets. Helm does not interpret ${...}, so an unsubstituted value is an
    # ordinary string here and renders fine — the guards this check exists to
    # catch are about which keys are declared, not what they expand to.
    if helm template "$release" "$chart" \
      --namespace "$target" \
      --values "$values" \
      </dev/null >/dev/null 2>"$WORK/helm.err"; then
      printf '  templated %s/%s with %s (values from %s)\n' \
        "$ns" "$name" "$chart" "$overlay"
    else
      printf '  FAILED %s/%s with %s (values from %s)\n' \
        "$ns" "$name" "$chart" "$overlay"
      sed 's/^/    /' "$WORK/helm.err"
      failures=$((failures + 1))
    fi
  done <"$list"
}

for overlay in "${OVERLAYS[@]}"; do
  rendered="$WORK/${overlay//\//_}.yaml"
  kubectl kustomize "$overlay" >"$rendered"
  printf 'rendered %s\n' "$overlay"
  template_releases "$rendered" "$overlay"
done

# A HelmRelease that names an in-repo chart but lives outside the overlays above
# is exactly the gap this script closes, so it is an error rather than silence:
# either the overlay belongs in OVERLAYS, or the chart is no longer reachable.
declared="$WORK/declared"
: >"$declared"
while IFS= read -r file; do
  yq eval-all '
    select(.kind == "HelmRelease")
    | select(.spec.chart.spec.chart // "" | test("^packages/charts/"))
    | (.metadata.namespace // "default") + "/" + .metadata.name
  ' "$file" 2>/dev/null >>"$declared" || true
done < <(grep -rl --include='*.yaml' 'packages/charts/' clusters/ || true)

uncovered="$(comm -23 <(sort -u "$declared") <(sort -u "$covered") || true)"
if [ -n "$uncovered" ]; then
  printf '\nHelmReleases naming an in-repo chart that no rendered overlay reached:\n'
  printf '%s\n' "$uncovered" | sed 's/^/  /'
  printf 'Add the overlay that carries them to OVERLAYS in %s.\n' "${BASH_SOURCE[0]}"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  printf '\n%d chart render check(s) failed\n' "$failures" >&2
  exit 1
fi
