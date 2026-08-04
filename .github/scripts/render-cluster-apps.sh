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

# Each entry is a path some Flux Kustomization names, so an overlay that is its
# own `spec.path` belongs here in its own right — being under `clusters/*/apps`
# does not mean the aggregate overlay includes it. oauth2-proxy is exactly that
# case, and it was rendered by nothing until it was listed.
OVERLAYS=(
  clusters/folly/apps
  clusters/offsite/apps
  clusters/folly/apps/arc
  clusters/offsite/apps/arc
  clusters/folly/apps/oauth2-proxy
  clusters/offsite/apps/oauth2-proxy
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

# A sign-in that starts at one host and calls back at another needs both hosts
# inside the cookie's scope, or the browser carries neither cookie across:
# the CSRF cookie is written where the flow starts and read at the callback,
# and the session cookie is written at the callback and read back at the App.
#
# So oauth2-proxy's `cookie-domain` must cover the host in its own
# `redirect-url`. That single rule catches both ways this has actually broken:
# an absent or null `cookie-domain`, which leaves every cookie host-only and
# unreadable one hop later; and a `cookie-domain` naming the *other* cluster's
# apex, which a strategic merge produces silently the moment an overlay omits
# the key (see `clusters/offsite/apps/oauth2-proxy/helm-release-patch.yaml`).
#
# Flux has not substituted its `${VAR}` postbuild values at this point, and that
# is what makes the second case visible: comparing the literal tokens is exactly
# how `.${SECRET_DOMAIN}` under `oauth2.${SPINDRIFT_DOMAIN}` fails to match.
cookie_checks=0
cookie_scope_contract() {
  local rendered="$1" overlay="$2"
  local ns name url domain host rest

  while IFS=$'\t' read -r ns name url domain; do
    [ -n "${ns:-}" ] || continue
    cookie_checks=$((cookie_checks + 1))

    host="${url#*://}"
    host="${host%%/*}"
    rest="${host%"$domain"}"

    # `rest` empty means cookie-domain equals the callback host exactly: a
    # host-only cookie the App can never read, which is the loop, not a fix.
    if [ -z "$domain" ] || [ "$rest" = "$host" ] || [ -z "$rest" ]; then
      printf '  FAILED %s/%s (%s): cookie-domain "%s" does not cover the redirect-url host "%s"\n' \
        "$ns" "$name" "$overlay" "$domain" "$host"
      failures=$((failures + 1))
    else
      printf '  cookie scope %s/%s: "%s" covers "%s"\n' "$ns" "$name" "$domain" "$host"
    fi
  done < <(yq eval-all '
    select(.kind == "HelmRelease")
    | select(.spec.values.extraArgs."redirect-url" // "" | length > 0)
    | [[ (.metadata.namespace // "default"),
         .metadata.name,
         .spec.values.extraArgs."redirect-url",
         (.spec.values.extraArgs."cookie-domain" // "") ]]
    | @tsv
  ' "$rendered")
}

for overlay in "${OVERLAYS[@]}"; do
  rendered="$WORK/${overlay//\//_}.yaml"
  kubectl kustomize "$overlay" >"$rendered"
  printf 'rendered %s\n' "$overlay"
  template_releases "$rendered" "$overlay"
  cookie_scope_contract "$rendered" "$overlay"
done

# The contract above has to have looked at something. `redirect-url` is what
# selects a release into it, so a rename or a deleted key would otherwise turn
# the whole check into silence that reads green.
if [ "$cookie_checks" -eq 0 ]; then
  printf '\nNo rendered HelmRelease declares extraArgs.redirect-url, so the cookie\n'
  printf 'scope contract checked nothing. Either the key moved or an overlay is\n'
  printf 'missing from OVERLAYS in %s.\n' "${BASH_SOURCE[0]}"
  failures=$((failures + 1))
fi

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
