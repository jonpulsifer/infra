#!/usr/bin/env bash
# Copies the v1 kthx sites, releases and release objects into the v2 control
# database and depot bucket. Prints the plan; `--apply` runs it. A rerun is safe:
# inserts are ON CONFLICT DO NOTHING and copies are --no-clobber.
set -euo pipefail

CONTEXT=${KTHX_CONTEXT:-offsite}
SOURCE_CLUSTER=${KTHX_SOURCE_CLUSTER:-spindrift-db}
SOURCE_NAMESPACE=${KTHX_SOURCE_NAMESPACE:-spindrift}
SOURCE_DATABASE=${KTHX_SOURCE_DATABASE:-spindrift}
TARGET_CLUSTER=${KTHX_TARGET_CLUSTER:-kthx-db}
TARGET_NAMESPACE=${KTHX_TARGET_NAMESPACE:-kthx}
TARGET_DATABASE=${KTHX_TARGET_DATABASE:-kthx}
BUCKET=${KTHX_BUCKET:-bluenose-kthx}
ZONE=${KTHX_ZONE:-kthx.dev}

apply=false
case ${1:-} in
  --apply) apply=true ;;
  '') ;;
  *)
    echo "usage: $0 [--apply]" >&2
    exit 2
    ;;
esac

die() {
  echo "kthx-carry-over: $1" >&2
  exit 1
}

# Spliced into SQL below, so it must be a GCS bucket name, which has no quote.
[[ $BUCKET =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || die "$BUCKET is not a bucket name"

# `-i=false -t=false` lets the output be captured; `-Atq` prints bare values.
source_psql() {
  kubectl cnpg psql -i=false -t=false --context "$CONTEXT" -n "$SOURCE_NAMESPACE" \
    "$SOURCE_CLUSTER" -- -d "$SOURCE_DATABASE" -Atq -v ON_ERROR_STOP=1 -c "$1"
}

target_psql() {
  kubectl cnpg psql -i=false -t=false --context "$CONTEXT" -n "$TARGET_NAMESPACE" \
    "$TARGET_CLUSTER" -- -d "$TARGET_DATABASE" -Atq -v ON_ERROR_STOP=1 -c "$1"
}

# Captured first: inside `[[ ]]` an unreachable cluster would read as un-migrated.
booted=$(target_psql "select to_regclass('public.sites') is not null") \
  || die "cannot reach $TARGET_CLUSTER in $TARGET_NAMESPACE on context $CONTEXT"
[[ $booted == t ]] \
  || die "$TARGET_DATABASE has no sites table -- the kthx server has not booted yet"

names=$(source_psql "select string_agg(quote_literal(name), ',' order by name) from kthx_sites")
if [[ -z $names ]]; then
  echo "nothing to carry: kthx_sites is empty"
  exit 0
fi

# Each carried name becomes a database and a login role on first touch, and
# provisioning would adopt an existing object with that name.
collisions=$(target_psql "
  select datname from pg_database where datname in ($names)
  union
  select rolname from pg_roles where rolname in ($names)")
[[ -z $collisions ]] || die "the target cluster already holds: $(tr '\n' ' ' <<<"$collisions")"

# v1 digests carry a `sha256:` prefix and v2 stores bare hex. Tab-separated,
# digest first, so a v1 location that contains a space reads as one field.
copies=$(source_psql "
  select distinct regexp_replace(digest, '^sha256:', '') || E'\t' || location
  from kthx_releases order by 1")

# `provisioned_at` stays null, so the server creates each live site's database
# and role on first touch or at start-up. Deleted sites never get one.
sites_sql=$(source_psql "
  select format(
    'insert into sites (name, token_hash, serving, held, created_at, deleted_at) values (%L,%L,%L,%L,%L,%L) on conflict (name) do nothing;',
    name, token_hash, serving, held, created_at, deleted_at)
  from kthx_sites order by name")

releases_sql=$(source_psql "
  select format(
    'insert into releases (site, n, digest, size, location, at) values (%L,%L,%L,%L,%L,%L) on conflict (site, n) do nothing;',
    site, n, regexp_replace(digest, '^sha256:', ''), size,
    'gs://$BUCKET/releases/' || regexp_replace(digest, '^sha256:', '') || '.tar.gz',
    created_at)
  from kthx_releases order by site, n")

echo "# objects to copy into gs://$BUCKET/releases/"
while IFS=$'\t' read -r hex location; do
  [[ -n $location ]] || continue
  [[ $location == gs://* ]] \
    || die "release object $location is not a gs:// address -- it was staged with no depot and cannot be carried"
  echo "gcloud storage cp --no-clobber $location gs://$BUCKET/releases/$hex.tar.gz"
done <<<"$copies"

# Never print the insert text: it carries every site's `token_hash`.
echo
echo "# sites to insert into $TARGET_DATABASE (name | serving | held | state)"
source_psql "
  select name || ' | ' || coalesce(serving::text, '-') || ' | ' || held
    || ' | ' || case when deleted_at is null then 'live' else 'deleted' end
  from kthx_sites order by name"

echo
echo "# releases to insert (site | n | digest)"
source_psql "
  select site || ' | ' || n || ' | ' || regexp_replace(digest, '^sha256:', '')
  from kthx_releases order by site, n"

if ! "$apply"; then
  echo
  echo "plan only. re-run with --apply to copy the objects and insert the rows."
  exit 0
fi

echo
# Runs as a person: no service account can read the source archives and write
# the depot, and the kthx account must never read private-repo sources.
while IFS=$'\t' read -r hex location; do
  [[ -n $location ]] || continue
  gcloud storage cp --no-clobber "$location" "gs://$BUCKET/releases/$hex.tar.gz"
done <<<"$copies"

# One `-c` string runs as one transaction, so no release lands without its site.
target_psql "$sites_sql
$releases_sql"

echo
echo "# carried"
target_psql "select
  'sites=' || (select count(*) from sites)
  || ' deleted=' || (select count(*) from sites where deleted_at is not null)
  || ' releases=' || (select count(*) from releases)
  || ' awaiting-database=' || (select count(*) from sites where deleted_at is null and provisioned_at is null)"

# v2 refuses some archives v1 accepted, and the only symptom is a 503 on the
# site host.
echo
echo "# carried sites, as the zone answers them"
while read -r name; do
  [[ -n $name ]] || continue
  printf '  %-24s %s\n' "$name" \
    "$(curl -sS -o /dev/null -w '%{http_code}' "https://$name.$ZONE/?carried=$$")"
done <<<"$(target_psql "
  select name from sites
  where deleted_at is null and serving is not null order by name")"

cat <<'NEXT'

Carried sites keep serving their files immediately -- static bytes never touch a
site database. The first `/api/*` request to each one answers 503 BUSY once
while its database and role are created, and works from then on; restarting the
server does the same thing up front.

A 200 above is a carried release this server unpacks. A 503 is one it refuses:
re-upload that site's files and nothing else changes.
NEXT
