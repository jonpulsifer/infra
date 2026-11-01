#!/usr/bin/env bash
# Checks kthx in production end to end on a throwaway site, then deletes it and
# frees its name. Usage: kthx-verify.sh [name].
# Needs curl, jq, bun, kubectl with cnpg, the kthx CLI
# (`bun add -g https://kthx.dev/cli/kthx.tgz`), and Application Default
# Credentials that may write the sites bucket.
set -euo pipefail

ZONE=${KTHX_ZONE:-kthx.dev}
CONTEXT=${KTHX_CONTEXT:-offsite}
NAMESPACE=${KTHX_NAMESPACE:-kthx}
CLUSTER=${KTHX_CLUSTER:-kthx-db}
DATABASE=${KTHX_DATABASE:-kthx}
# How long a deploy may take to show: the bucket mount caches each file's
# metadata for about ten seconds.
FRESH_SECONDS=${KTHX_FRESH_SECONDS:-30}

APEX="https://$ZONE"
NAME=${1:-smoke-$(date -u +%s)}
SITE="https://$NAME.$ZONE"

die() {
  echo "kthx-verify: $1" >&2
  exit 1
}

for tool in curl jq bun kthx kubectl; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done

tmp=$(mktemp -d)
deployed=no
cleanup() {
  local code=$?
  # Harmless after the final delete: a missing site deletes nothing.
  if [[ $deployed == yes ]]; then
    (cd "$tmp/v1" && printf '%s\n' "$NAME" | kthx rm --force) >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
  exit "$code"
}
trap cleanup EXIT

body=$tmp/body
head=$tmp/head
pass=0
fail=0

req() {
  local method=$1 url=$2
  shift 2
  curl -sS -o "$body" -D "$head" -w '%{http_code}' -X "$method" "$url" "$@"
}

check() {
  if [[ "$2" == "$3" ]]; then
    printf '  ok    %-44s %s\n' "$1" "$3"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-44s want %s, got %s\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

# A unique query string misses any edge cache after a deploy or a delete.
nonce=0
fresh() {
  nonce=$((nonce + 1))
  printf '%s?cachebust=%s-%s' "$1" "$$" "$nonce"
}

# Polls a path until its body holds the text, for at most FRESH_SECONDS.
shows() {
  local url=$1 text=$2 waited=0
  while ((waited < FRESH_SECONDS)); do
    req GET "$(fresh "$url")" >/dev/null || true
    grep -qF "$text" "$body" && echo yes && return
    sleep 2
    waited=$((waited + 2))
  done
  echo no
}

site_psql() {
  kubectl cnpg psql -i=false -t=false --context "$CONTEXT" -n "$NAMESPACE" \
    "$CLUSTER" -- -d "$DATABASE" -Atq -v ON_ERROR_STOP=1 -c "$1"
}

# Deploy 1 has a `404.html` and deploy 2 deletes it, so the status of an
# unknown path shows from outside which deploy serves.
mkdir -p "$tmp/v1/about" "$tmp/v2/about"
echo '<!doctype html><title>smoke</title>deploy one' >"$tmp/v1/index.html"
echo '<!doctype html>about one' >"$tmp/v1/about/index.html"
echo '<!doctype html>no such page' >"$tmp/v1/404.html"
echo '<!doctype html><title>smoke</title>deploy two' >"$tmp/v2/index.html"
echo '<!doctype html>about two' >"$tmp/v2/about/index.html"
echo 'console.log("two")' >"$tmp/v2/app.js"

# The CLI's update check writes under XDG_CONFIG_HOME, so this run stays out of
# the operator's own config.
export XDG_CONFIG_HOME="$tmp/config"
export KTHX_ORIGIN="${KTHX_ORIGIN:-$APEX}"

echo "kthx: $SITE"

echo
echo "deploy 1"
if (cd "$tmp/v1" && kthx deploy --name "$NAME") >"$tmp/deploy.log" 2>&1; then
  deployed=yes
  check 'kthx deploy' ok ok
else
  check 'kthx deploy' ok "failed: $(tail -1 "$tmp/deploy.log")"
  die "the first deploy failed: $(cat "$tmp/deploy.log")"
fi
check 'GET / shows deploy one' yes "$(shows "$SITE/" 'deploy one')"
check 'GET /about' 200 "$(req GET "$(fresh "$SITE/about")")"
check 'GET /nope falls to 404.html' 404 "$(req GET "$(fresh "$SITE/nope")")"
check '  is the site 404 page' yes "$(grep -qF 'no such page' "$body" && echo yes || echo no)"
check 'GET /.kthx is hidden' 404 "$(req GET "$(fresh "$SITE/.kthx")")"

req GET "$SITE/" >/dev/null
etag=$(grep -i '^etag:' "$head" | head -1 | sed 's/^[^:]*: *//' | tr -d '\r')
check 'GET / with if-none-match' 304 "$(req GET "$SITE/" -H "if-none-match: $etag")"

echo
echo "owner"
check 'kthx ls names the owner' yes \
  "$( (cd "$tmp/v1" && kthx ls) 2>&1 | grep -q 'owned by' && echo yes || echo no)"
check 'GET /api/names/:name is taken' false \
  "$(
    req GET "$APEX/api/names/$NAME" >/dev/null
    jq -r '.available' <"$body"
  )"
check 'GET /api/sites/:name with no token' 401 "$(req GET "$APEX/api/sites/$NAME")"

echo
echo "visitor"
check 'GET /api/me' 200 "$(req GET "$SITE/api/me")"
cookie=$(grep -i '^set-cookie: __Host-kthx_me=' "$head" | head -1 \
  | sed 's/^[^:]*: *//; s/;.*//' | tr -d '\r')
check '  mints __Host-kthx_me' yes "$([[ -n $cookie ]] && echo yes || echo no)"
me=$(jq -r '.id // empty' <"$body")
req GET "$SITE/api/me" -H "cookie: $cookie" >/dev/null
check '  keeps a signed cookie' "$me" "$(jq -r '.id // empty' <"$body")"

echo
echo "documents"
# As a browser sends them: a non-GET `/api/*` with an `Origin` must name this
# host, and a JSON route needs a `content-type`.
json=(-H "cookie: $cookie" -H "origin: $SITE" -H 'content-type: application/json')

check 'POST /api/db/notes' 201 "$(req POST "$SITE/api/db/notes" "${json[@]}" \
  -d '{"kind":"smoke","n":1}')"
doc=$(jq -r '.id // empty' <"$body")
first=$(jq -r '.etag // empty' <"$body")

check 'POST /api/db/notes/query' 200 "$(req POST "$SITE/api/db/notes/query" "${json[@]}" \
  -d '{"where":{"kind":"smoke"},"count":true}')"
check '  counts the document' 1 "$(jq -r '.count // empty' <"$body")"

check 'PATCH with a current if-match' 200 "$(req PATCH "$SITE/api/db/notes/$doc" \
  "${json[@]}" -H "if-match: $first" -d '{"n":2}')"
check '  merged the patch' 2 "$(jq -r '.n // empty' <"$body")"
second=$(jq -r '.etag // empty' <"$body")

check 'PATCH with a stale if-match' 412 "$(req PATCH "$SITE/api/db/notes/$doc" \
  "${json[@]}" -H "if-match: $first" -d '{"n":3}')"

check 'DELETE the document' 204 "$(req DELETE "$SITE/api/db/notes/$doc" \
  "${json[@]}" -H "if-match: $second")"
check 'GET the deleted document' 404 "$(req GET "$SITE/api/db/notes/$doc" \
  -H "cookie: $cookie")"

echo
echo "realtime"
# Subscribe, write over HTTP, and wait for the create frame the write fans out.
# shellcheck disable=SC2016 # the single quotes are the point: this is JavaScript
saw=$(bun -e '
const [site, cookie] = Bun.argv.slice(-2);
const socket = new WebSocket(`${site.replace(/^http/, "ws")}/api/ws`, {
  headers: { origin: site, cookie },
});
let deadline;
const frame = new Promise((resolve, reject) => {
  socket.onmessage = (event) => {
    const it = JSON.parse(event.data);
    if (it.t === "create" && it.collection === "smoke") resolve(it.id);
  };
  deadline = setTimeout(() => reject(new Error("no create frame in 15s")), 15000);
});
await new Promise((open, broke) => {
  socket.onopen = open;
  socket.onerror = () => broke(new Error("the upgrade was refused"));
});
socket.send(JSON.stringify({ t: "sub", collection: "smoke" }));
await Bun.sleep(500);
const wrote = await fetch(`${site}/api/db/smoke`, {
  method: "POST",
  headers: { origin: site, cookie, "content-type": "application/json" },
  body: JSON.stringify({ over: "the socket" }),
});
if (wrote.status !== 201) throw new Error(`the write answered ${wrote.status}`);
const announced = await frame;
// The deadline would otherwise hold the event loop open for its full 15s.
clearTimeout(deadline);
socket.close();
console.log(announced === (await wrote.json()).id ? "yes" : "wrong id");
' "$SITE" "$cookie" 2>"$tmp/ws.log" || echo "no: $(tail -1 "$tmp/ws.log")")
check 'a subscriber sees the write' yes "$saw"

echo
echo "deploy 2"
printf '{"name":"%s"}\n' "$NAME" >"$tmp/v2/kthx.json"
if (cd "$tmp/v2" && kthx deploy) >"$tmp/deploy.log" 2>&1; then
  check 'kthx deploy' ok ok
else
  check 'kthx deploy' ok "failed: $(tail -1 "$tmp/deploy.log")"
fi
check '  uploads only what changed' yes \
  "$(grep -q '3 uploaded' "$tmp/deploy.log" && echo yes || echo no)"
check 'GET / shows deploy two' yes "$(shows "$SITE/" 'deploy two')"
check 'GET /app.js' 200 "$(req GET "$(fresh "$SITE/app.js")")"
check 'GET /404.html is deleted' 404 "$(req GET "$(fresh "$SITE/404.html")")"

echo
echo "delete"
if (cd "$tmp/v2" && printf '%s\n' "$NAME" | kthx rm) >"$tmp/rm.log" 2>&1; then
  check 'kthx rm' ok ok
else
  check 'kthx rm' ok "failed: $(tail -1 "$tmp/rm.log")"
fi
check '  the name is free' true \
  "$(
    req GET "$APEX/api/names/$NAME" >/dev/null
    jq -r '.available' <"$body"
  )"
check '  the site API answers 404' 404 "$(req GET "$(fresh "$SITE/api")")"
check '  the site database is dropped' 0 \
  "$(site_psql "select count(*) from pg_database where datname = '$NAME'")"
check '  the site role is dropped' 0 \
  "$(site_psql "select count(*) from pg_roles where rolname = '$NAME'")"

echo
echo "$pass ok, $fail failed"
[[ $fail -eq 0 ]]
