#!/usr/bin/env bash
# Renders every Flux Kustomization path in clusters/, templates each in-repo
# chart a rendered HelmRelease names with that release's values, and checks the
# oauth2-proxy cookie scope and ext_authz redirect.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Every Flux Kustomization spec.path that is a directory in this repo.
mapfile -t OVERLAYS < <(
  grep -rl 'kustomize.toolkit.fluxcd.io' clusters/ --include='*.yaml' \
    | xargs -r yq eval-all 'select(.kind == "Kustomization") | .spec.path' \
    | sed 's|^\./||' \
    | grep -v '^null$' \
    | sort -u \
    | while read -r path; do [[ -d $path ]] && printf '%s\n' "$path"; done
)

if ((${#OVERLAYS[@]} == 0)); then
  printf 'derived no overlays; the Kustomization declarations or yq broke.\n' >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ns/name of every HelmRelease templated, for the coverage check at the end.
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

    # Flux postBuild variables are unsubstituted here, and Helm renders them as
    # plain strings.
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

# oauth2-proxy's cookie-domain must cover its redirect-url host, or neither
# cookie crosses between the sign-in host, the callback and the App.
cookie_checks=0
cookie_scope_contract() {
  local rendered="$1" overlay="$2"
  local ns name url domain host rest

  while IFS=$'\t' read -r ns name url domain; do
    [ -n "${ns:-}" ] || continue
    cookie_checks=$((cookie_checks + 1))

    host="${url#*://}"
    host="${host%%/*}"
    # Compared before Flux substitution, so a base domain variable left in place
    # by an overlay that omits cookie-domain does not match.
    rest="${host%"$domain"}"

    # An empty `rest` means cookie-domain is the callback host: a host-only cookie
    # the App cannot read.
    if [ -z "$domain" ] || [ "$rest" = "$host" ] || [ -z "$rest" ]; then
      printf '  FAILED %s/%s (%s): cookie-domain "%s" does not cover the redirect-url host "%s"\n' \
        "$ns" "$name" "$overlay" "$domain" "$host"
      failures=$((failures + 1))
    else
      printf '  cookie scope %s/%s: "%s" covers "%s"\n' "$ns" "$name" "$domain" "$host"
    fi
    # extraArgs is a sequence in some charts, and indexing a sequence by name is
    # a yq error, so the type is checked first.
  done < <(yq eval-all '
    select(.kind == "HelmRelease")
    | select(.spec.values.extraArgs | type == "!!map")
    | select(.spec.values.extraArgs."redirect-url" // "" | length > 0)
    | [[ (.metadata.namespace // "default"),
         .metadata.name,
         .spec.values.extraArgs."redirect-url",
         (.spec.values.extraArgs."cookie-domain" // "") ]]
    | @tsv
  ' "$rendered")
}

# ExternalAuth hands oauth2-proxy no origin, so the nginx shim beside it sets
# X-Auth-Request-Redirect, or a sign-in ends on the callback host.
authz_checks=0
authz_redirect_contract() {
  local rendered="$1" overlay="$2"
  local conf="$WORK/authz-${overlay//\//_}.conf" target

  yq eval-all '
    select(.kind == "HelmRelease")
    | .spec.values.extraObjects[]?
    | select(.kind == "ConfigMap")
    | .data."nginx.conf"
  ' "$rendered" >"$conf" 2>/dev/null || true

  grep -q '[^[:space:]]' "$conf" || return 0
  authz_checks=$((authz_checks + 1))

  # proxy_set_header replaces a copy of the header sent by the client.
  target="$(sed -n \
    's/^[[:space:]]*proxy_set_header[[:space:]]\{1,\}X-Auth-Request-Redirect[[:space:]]\{1,\}\(.*\);[[:space:]]*$/\1/p' \
    "$conf")"

  # The target must be absolute and built from the request's own host.
  # shellcheck disable=SC2016  # `$http_host` is nginx's variable, not the shell's
  case "$target" in
    'https://$http_host'*)
      printf '  authz redirect %s: "%s"\n' "$overlay" "$target"
      ;;
    *)
      printf '  FAILED %s: the ext_authz shim sets X-Auth-Request-Redirect to "%s",\n' \
        "$overlay" "$target"
      printf '    not an absolute origin composed from the request host\n'
      failures=$((failures + 1))
      ;;
  esac
}

# Flux generates a kustomization for a directory without one, and kubectl
# kustomize does not, so this writes one into a copy.
render_overlay() {
  local overlay="$1" out="$2" copy
  if [[ -f $overlay/kustomization.yaml || -f $overlay/kustomization.yml ]]; then
    kubectl kustomize "$overlay" >"$out"
    return
  fi
  copy="$WORK/gen-${overlay//\//_}"
  mkdir -p "$copy"
  cp -r "$overlay"/. "$copy"/
  # Each file is listed by name: `kustomize create --autodetect` silently drops a
  # file it cannot parse.
  {
    printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n'
    (cd "$copy" && find . -type f \( -name '*.yaml' -o -name '*.yml' \) \
      ! -name kustomization.yaml ! -name kustomization.yml \
      | sed 's|^\./||' | sort | sed 's|^|  - |')
  } >"$copy/kustomization.yaml"
  kubectl kustomize "$copy" >"$out"
}

for overlay in "${OVERLAYS[@]}"; do
  rendered="$WORK/${overlay//\//_}.yaml"
  render_overlay "$overlay" "$rendered"
  printf 'rendered %s\n' "$overlay"
  template_releases "$rendered" "$overlay"
  cookie_scope_contract "$rendered" "$overlay"
  authz_redirect_contract "$rendered" "$overlay"
done

# A renamed extraObjects entry or a deleted ConfigMap would leave nothing to check.
if [ "$authz_checks" -eq 0 ]; then
  printf '\nNo rendered HelmRelease carries an extraObjects ConfigMap with an\n'
  printf 'nginx.conf, so the ext_authz redirect contract checked nothing. Either\n'
  printf 'the shim moved or an overlay is missing from OVERLAYS in %s.\n' "${BASH_SOURCE[0]}"
  failures=$((failures + 1))
fi

# A renamed or deleted redirect-url key would leave nothing to check.
if [ "$cookie_checks" -eq 0 ]; then
  printf '\nNo rendered HelmRelease declares extraArgs.redirect-url, so the cookie\n'
  printf 'scope contract checked nothing. Either the key moved or an overlay is\n'
  printf 'missing from OVERLAYS in %s.\n' "${BASH_SOURCE[0]}"
  failures=$((failures + 1))
fi

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
