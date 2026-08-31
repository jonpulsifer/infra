#!/usr/bin/env bash
# Carry the v1 kthx rows into the v2 control database. One shot, by hand, once.
#
# Prints the plan; does nothing until `--apply`. Idempotent either way: every
# insert is ON CONFLICT DO NOTHING and every copy is --no-clobber, so a run that
# stopped half way is finished by running it again.
#
# WHY THIS IS NOT A JOB
#
# The rows live in Spindrift's own control database (`spindrift-db`, namespace
# `spindrift`) and have to land in `kthx-db`, namespace `kthx`. A `secretKeyRef`
# does not cross a namespace, so a Job in either namespace can hold exactly one
# of the two credentials. The gap that closes for a Datastore --
# `clusters/base/platform/spindrift-datastore-store/` -- is pinned to
# `remoteNamespace: spindrift-datastores`, so reaching `spindrift-db-app` would
# take a second ClusterSecretStore plus a Role granting external-secrets
# `get secrets` over the whole `spindrift` namespace, permanently, to move
# thirteen rows once.
#
# The bucket half cannot be a Job either, and that one is deliberate: the kthx
# service account holds `roles/storage.objectAdmin` on `bluenose-kthx` and
# nothing else. It has no read on `bluenose-spindrift-source` and is not getting
# one -- that bucket holds every vessel's source archives, private repos
# included, and kthx is a public anonymous-write zone
# (`terraform/gcp/projects/bluenose/iam.tf`). So the objects are copied by an
# operator who can see both buckets, which is what makes the rewritten
# `location` readable afterwards.
#
# WHAT IS NOT CARRIED
#
# `kthx_kv`. The v1 key->JSON plane is retired; v2's `/api/db` is collections in
# a database per site and nothing translates between the two. `/_/*` answers
# 410. The table is dropped by the Spindrift migration in the deletion PR.
#
# PREREQUISITES
#
# - `kubectl` with the `cnpg` plugin, and a context that reaches offsite.
# - `gcloud`, authenticated as somebody who can read `bluenose-spindrift-source`
#   and write `bluenose-kthx`. Neither service account can do both.
# - The kthx server has booted at least once: it applies its own migrations at
#   start-up, and there is nothing to insert into until it has.
set -euo pipefail

CONTEXT=${KTHX_CONTEXT:-offsite}
SOURCE_CLUSTER=${KTHX_SOURCE_CLUSTER:-spindrift-db}
SOURCE_NAMESPACE=${KTHX_SOURCE_NAMESPACE:-spindrift}
SOURCE_DATABASE=${KTHX_SOURCE_DATABASE:-spindrift}
TARGET_CLUSTER=${KTHX_TARGET_CLUSTER:-kthx-db}
TARGET_NAMESPACE=${KTHX_TARGET_NAMESPACE:-kthx}
TARGET_DATABASE=${KTHX_TARGET_DATABASE:-kthx}
BUCKET=${KTHX_BUCKET:-bluenose-kthx}

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

# Spliced into SQL text below, so it is checked rather than trusted. Google's
# own bucket-name grammar, which has no quote in it.
[[ $BUCKET =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || die "$BUCKET is not a bucket name"

# `-i=false -t=false`: no stdin to forward and no TTY to allocate, which is what
# lets the output be captured. `-Atq` is one bare value per line.
source_psql() {
  kubectl cnpg psql -i=false -t=false --context "$CONTEXT" -n "$SOURCE_NAMESPACE" \
    "$SOURCE_CLUSTER" -- -d "$SOURCE_DATABASE" -Atq -v ON_ERROR_STOP=1 -c "$1"
}

target_psql() {
  kubectl cnpg psql -i=false -t=false --context "$CONTEXT" -n "$TARGET_NAMESPACE" \
    "$TARGET_CLUSTER" -- -d "$TARGET_DATABASE" -Atq -v ON_ERROR_STOP=1 -c "$1"
}

# --- pre-flight -------------------------------------------------------------

[[ $(target_psql "select to_regclass('public.sites') is not null") == t ]] \
  || die "$TARGET_DATABASE has no sites table -- the kthx server has not booted yet"

names=$(source_psql "select string_agg(quote_literal(name), ',' order by name) from kthx_sites")
if [[ -z $names ]]; then
  echo "nothing to carry: kthx_sites is empty"
  exit 0
fi

# A carried name becomes a DATABASE and a LOGIN role the first time the site is
# touched. Anything already wearing that name in the target cluster would make
# the server's provisioning adopt an object it did not create, so this refuses
# rather than discovering it later.
collisions=$(target_psql "
  select datname from pg_database where datname in ($names)
  union
  select rolname from pg_roles where rolname in ($names)")
[[ -z $collisions ]] || die "the target cluster already holds: $(tr '\n' ' ' <<<"$collisions")"

# --- the plan ---------------------------------------------------------------

# One line per distinct release object: where it is now, and the digest that
# names it in the kthx depot. v1 stores `sha256:<hex>`; v2 stores the bare hex.
copies=$(source_psql "
  select distinct location || ' ' || regexp_replace(digest, '^sha256:', '')
  from kthx_releases order by 1")

sites_sql=$(source_psql "
  select format(
    'insert into sites (name, token_hash, serving, held, created_at, deleted_at) values (%L,%L,%L,%L,%L,%L) on conflict (name) do nothing;',
    name, token_hash, serving, held, created_at, deleted_at)
  from kthx_sites order by name")

# `provisioned_at` is deliberately left null: it is what makes the server create
# each site's database and role on first touch (or at its next start-up), which
# is the same repair path a restore uses. The soft-deleted names keep their
# `deleted_at`, stay taken, and are never given a database.
releases_sql=$(source_psql "
  select format(
    'insert into releases (site, n, digest, size, location, at) values (%L,%L,%L,%L,%L,%L) on conflict (site, n) do nothing;',
    site, n, regexp_replace(digest, '^sha256:', ''), size,
    'gs://$BUCKET/releases/' || regexp_replace(digest, '^sha256:', '') || '.tar.gz',
    created_at)
  from kthx_releases order by site, n")

echo "# objects to copy into gs://$BUCKET/releases/"
while read -r location hex; do
  [[ -n $location ]] || continue
  [[ $location == gs://* ]] \
    || die "release object $location is not a gs:// address -- it was staged with no depot and cannot be carried"
  echo "gcloud storage cp --no-clobber $location gs://$BUCKET/releases/$hex.tar.gz"
done <<<"$copies"

echo
echo "# rows to insert into $TARGET_DATABASE"
echo "$sites_sql"
echo "$releases_sql"

if ! "$apply"; then
  echo
  echo "plan only. re-run with --apply to copy the objects and insert the rows."
  exit 0
fi

# --- apply ------------------------------------------------------------------

echo
while read -r location hex; do
  [[ -n $location ]] || continue
  gcloud storage cp --no-clobber "$location" "gs://$BUCKET/releases/$hex.tar.gz"
done <<<"$copies"

# One `-c` string is one implicit transaction, so the sites land before the
# releases that reference them or neither lands at all.
target_psql "$sites_sql
$releases_sql"

echo
echo "# carried"
target_psql "select
  'sites=' || (select count(*) from sites)
  || ' deleted=' || (select count(*) from sites where deleted_at is not null)
  || ' releases=' || (select count(*) from releases)
  || ' awaiting-database=' || (select count(*) from sites where deleted_at is null and provisioned_at is null)"

cat <<'NEXT'

Carried sites keep serving their files immediately -- static bytes never touch a
site database. The first `/api/*` request to each one answers 503 BUSY once
while its database and role are created, and works from then on; restarting the
server does the same thing up front. Nothing else has to be done.
NEXT
