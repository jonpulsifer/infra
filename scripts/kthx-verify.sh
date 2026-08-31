#!/usr/bin/env bash
# Verify kthx against production, end to end, on a throwaway name.
#
# Claim -> upload a zip -> serve -> `/api/me` -> `/api/db` -> `/api/ws` -> a
# second release -> roll back -> hold -> release -> adopt -> a credential that
# opens nothing -> delete -> 410 -> the site database is gone. Run it after the
# HTTPRoute is live; it touches nothing that exists already.
#
# A site is owned by a Google account, so this runs as whoever `gcloud auth
# print-identity-token` answers for. The one thing it cannot do over HTTP is
# make a site that predates accounts, which is what `adopt` exists for: it
# writes a bearer hash onto the smoke site's own row over `kubectl cnpg psql`,
# adopts it back, and asserts both halves. That is the throwaway site's row and
# nothing else.
#
# The smoke site is deleted on the way out even when a check fails -- a kthx
# name is never freed, so an abandoned run would take one forever.
#
# Needs: curl, jq, bun, gcloud (signed in), sha256sum, `kthx` on PATH
# (`bun add -g https://kthx.dev/cli/kthx.tgz`), kubectl with the cnpg plugin,
# and either zip or python3 for the one zip. `$XDG_CONFIG_HOME` is pointed at a
# temp directory, so the operator's own `~/.config/kthx` is not touched.
set -euo pipefail

ZONE=${KTHX_ZONE:-kthx.dev}
CONTEXT=${KTHX_CONTEXT:-offsite}
NAMESPACE=${KTHX_NAMESPACE:-kthx}
CLUSTER=${KTHX_CLUSTER:-kthx-db}
DATABASE=${KTHX_DATABASE:-kthx}

APEX="https://$ZONE"
NAME=${1:-smoke-$(date -u +%s)}
SITE="https://$NAME.$ZONE"

die() {
  echo "kthx-verify: $1" >&2
  exit 1
}

for tool in curl jq bun gcloud sha256sum kthx kubectl; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done

# The credential every owner call carries. Minted once: it is good for an hour
# and this run is a minute.
IDT=$(gcloud auth print-identity-token 2>/dev/null) \
  || die "gcloud auth print-identity-token failed -- run gcloud auth login"
[[ -n $IDT ]] || die "gcloud auth print-identity-token printed nothing"
auth=(-H "authorization: Bearer $IDT")

tmp=$(mktemp -d)
CLAIMED=""
BEARER=""
cleanup() {
  local code=$?
  # Best effort, and harmless twice: a deleted name answers 410 here. Both
  # credentials are tried, because a run that stops mid-adopt leaves the site
  # answering to the bearer rather than to the account.
  if [[ -n $CLAIMED ]]; then
    curl -sS -o /dev/null -X DELETE "$APEX/api/sites/$NAME" "${auth[@]}" || true
    [[ -z $BEARER ]] \
      || curl -sS -o /dev/null -X DELETE "$APEX/api/sites/$NAME" \
        -H "authorization: Bearer $BEARER" || true
  fi
  rm -rf "$tmp"
  exit "$code"
}
trap cleanup EXIT

body=$tmp/body
head=$tmp/head
pass=0
fail=0

# `req METHOD URL [curl args...]` prints the status; the body lands in $body and
# the response headers in $head.
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

# Cloudflare caches a site's static responses on the origin's terms, and the
# origin says `public, max-age=60`. A check that runs straight after a release
# change or a delete would otherwise read the previous release out of the edge.
# A unique query string is a different cache key and the server ignores it — it
# dispatches on the path alone.
nonce=0
fresh() {
  nonce=$((nonce + 1))
  printf '%s?cachebust=%s-%s' "$1" "$$" "$nonce"
}

site_psql() {
  kubectl cnpg psql -i=false -t=false --context "$CONTEXT" -n "$NAMESPACE" \
    "$CLUSTER" -- -d "$DATABASE" -Atq -v ON_ERROR_STOP=1 -c "$1"
}

zip_dir() {
  if command -v zip >/dev/null; then
    (cd "$1" && zip -qr "$2" .)
  elif command -v python3 >/dev/null; then
    python3 -c 'import shutil,sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])' "$2" "$1"
  else
    die "neither zip nor python3 is on PATH, and release 1 is uploaded as a zip"
  fi
}

# --- fixtures ---------------------------------------------------------------

# Release 1 carries a `404.html` and no `200.html`, so an unknown path is a 404.
# Release 2 carries a `200.html`, so the same path is Quick's SPA fallback and
# answers 200. That difference is what makes the rollback below observable from
# the outside rather than only in the control API.
mkdir -p "$tmp/v1/about" "$tmp/v2/about"
echo '<!doctype html><title>smoke</title>release one' >"$tmp/v1/index.html"
echo '<!doctype html>about one' >"$tmp/v1/about/index.html"
echo '<!doctype html>no such page' >"$tmp/v1/404.html"
echo '<!doctype html><title>smoke</title>release two' >"$tmp/v2/index.html"
echo '<!doctype html>about two' >"$tmp/v2/about/index.html"
echo '<!doctype html>spa fallback' >"$tmp/v2/200.html"
zip_dir "$tmp/v1" "$tmp/v1.zip"

echo "kthx: $SITE"

# --- claim ------------------------------------------------------------------

echo
echo "identity"
check 'GET /api/whoami' 200 "$(req GET "$APEX/api/whoami" "${auth[@]}")"
WHO=$(jq -r '.email // empty' <"$body")
[[ -n $WHO ]] || die "whoami returned no address: $(cat "$body")"
check '  unauthenticated' 401 "$(req GET "$APEX/api/whoami")"

echo
echo "claim"
# A name belongs to an account now, so an anonymous claim is refused and the
# refusal points at the command line rather than at a form.
check 'POST /api/sites anonymous' 401 "$(req POST "$APEX/api/sites" \
  -H 'content-type: application/json' -d "{\"name\":\"$NAME\"}")"
check '  says UNAUTHENTICATED' UNAUTHENTICATED "$(jq -r '.code // empty' <"$body")"

check 'POST /api/sites' 201 "$(req POST "$APEX/api/sites" "${auth[@]}" \
  -H 'content-type: application/json' -d "{\"name\":\"$NAME\"}")"
CLAIMED=$NAME
# Nothing is shown once any more: the account is the credential.
check '  answers no token' null "$(jq -r '.token // "null"' <"$body")"

check 'GET /api/sites/:name' 200 "$(req GET "$APEX/api/sites/$NAME" "${auth[@]}")"
check '  names its owner' "$WHO" "$(jq -r '.owner // empty' <"$body")"

# The CLI reads its config and its apex from the environment, so pointing both
# at the temp directory keeps this run out of the operator's own.
export XDG_CONFIG_HOME="$tmp/config"
export KTHX_ORIGIN="$APEX"
mkdir -p "$XDG_CONFIG_HOME/kthx"
printf '{"name":"%s"}\n' "$NAME" >"$tmp/v2/kthx.json"

# --- release 1, served ------------------------------------------------------

echo
echo "release 1 (zip, curl)"
check 'POST /api/sites/:name/releases' 201 "$(req POST "$APEX/api/sites/$NAME/releases" \
  "${auth[@]}" -H 'x-filename: site.zip' \
  --data-binary "@$tmp/v1.zip")"
check '  serving' 1 "$(jq -r '.serving // empty' <"$body")"

check 'GET /' 200 "$(req GET "$SITE/")"
check '  is release one' yes "$(grep -qF 'release one' "$body" && echo yes || echo no)"
check 'GET /about' 200 "$(req GET "$SITE/about")"
check 'GET /nope falls to 404.html' 404 "$(req GET "$SITE/nope")"
check '  is the site 404 page' yes "$(grep -qF 'no such page' "$body" && echo yes || echo no)"

req GET "$SITE/" >/dev/null
etag=$(grep -i '^etag:' "$head" | head -1 | sed 's/^[^:]*: *//' | tr -d '\r')
check 'GET / with if-none-match' 304 "$(req GET "$SITE/" -H "if-none-match: $etag")"

# --- /api/me ----------------------------------------------------------------

echo
echo "visitor"
check 'GET /api/me' 200 "$(req GET "$SITE/api/me")"
cookie=$(grep -i '^set-cookie: __Host-kthx_me=' "$head" | head -1 \
  | sed 's/^[^:]*: *//; s/;.*//' | tr -d '\r')
check '  mints __Host-kthx_me' yes "$([[ -n $cookie ]] && echo yes || echo no)"
me=$(jq -r '.id // empty' <"$body")
req GET "$SITE/api/me" -H "cookie: $cookie" >/dev/null
check '  keeps a signed cookie' "$me" "$(jq -r '.id // empty' <"$body")"

# --- /api/db ----------------------------------------------------------------

echo
echo "documents"
# Every non-GET `/api/*` from a browser has to carry a same-host `Origin`, and
# every JSON route a `content-type` -- `kthx.dev` is not on the Public Suffix
# List, so a sibling site is same-site to a cookie and the guard is the header.
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

# --- /api/ws ----------------------------------------------------------------

echo
echo "realtime"
# Subscribe, write over HTTP, and wait for the frame the write fans out. In
# process and single replica by construction, so this is the whole of it.
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

# --- release 2, rollback, hold ----------------------------------------------

echo
echo "releases"
if kthx deploy "$tmp/v2" >"$tmp/deploy.log" 2>&1; then
  check 'kthx deploy' ok ok
else
  check 'kthx deploy' ok "failed: $(tail -1 "$tmp/deploy.log")"
fi
req GET "$APEX/api/sites/$NAME" "${auth[@]}" >/dev/null
check '  serving' 2 "$(jq -r '.serving // empty' <"$body")"
check '  /nope is now the SPA fallback' 200 "$(req GET "$(fresh "$SITE/nope")")"

# `kthx rollback` and `kthx release` read `kthx.json` from the working
# directory, not from an argument.
(cd "$tmp/v2" && kthx rollback 1) >"$tmp/rollback.log" 2>&1 \
  || cat "$tmp/rollback.log"
req GET "$APEX/api/sites/$NAME" "${auth[@]}" >/dev/null
check 'kthx rollback 1 serves' 1 "$(jq -r '.serving // empty' <"$body")"
check '  and holds' true "$(jq -r '.held' <"$body")"
check '  release 1 answers 404 again' 404 "$(req GET "$(fresh "$SITE/nope")")"

(cd "$tmp/v2" && kthx release) >"$tmp/release.log" 2>&1 || cat "$tmp/release.log"
req GET "$APEX/api/sites/$NAME" "${auth[@]}" >/dev/null
check 'kthx release drops the hold' false "$(jq -r '.held' <"$body")"
check '  the newest release serves' 2 "$(jq -r '.serving // empty' <"$body")"

# --- the bearer, and the end ------------------------------------------------

# --- adopt ------------------------------------------------------------------

echo
echo "adopt"
# A site that predates accounts, made the only way one can be made now: the
# row's own owner columns cleared and a bearer hash written onto it.
BEARER="verify-$(head -c 24 /dev/urandom | base64 | tr -d '=+/')"
BEARER_HASH=$(printf %s "$BEARER" | sha256sum | cut -d' ' -f1)
site_psql "update sites set owner_sub = null, owner_email = null,
  token_hash = '$BEARER_HASH' where name = '$NAME'" >/dev/null

check 'the identity does not own it yet' 403 "$(req GET "$APEX/api/sites/$NAME" \
  "${auth[@]}")"
check 'the old bearer still opens it' 200 "$(req GET "$APEX/api/sites/$NAME" \
  -H "authorization: Bearer $BEARER")"
check '  and the directory says unadopted' null \
  "$(req GET "$APEX/api/sites?limit=500" >/dev/null; \
     jq -r --arg n "$NAME" '.items[] | select(.name == $n) | .owner // "null"' <"$body")"

adopt='content-type: application/json'
check 'POST …/adopt anonymous' 401 "$(req POST "$APEX/api/sites/$NAME/adopt" \
  -H "$adopt" -d '{"token":"'"$BEARER"'"}')"
check 'POST …/adopt with the wrong token' 403 \
  "$(req POST "$APEX/api/sites/$NAME/adopt" "${auth[@]}" -H "$adopt" \
    -d '{"token":"not-the-token"}')"
check 'POST …/adopt' 204 "$(req POST "$APEX/api/sites/$NAME/adopt" \
  "${auth[@]}" -H "$adopt" -d '{"token":"'"$BEARER"'"}')"

check '  the identity owns it now' 200 "$(req GET "$APEX/api/sites/$NAME" \
  "${auth[@]}")"
check '  and it says so' "$WHO" "$(jq -r '.owner // empty' <"$body")"
check '  the old bearer is spent' 403 "$(req GET "$APEX/api/sites/$NAME" \
  -H "authorization: Bearer $BEARER")"
check '  adopting again is 409' 409 "$(req POST "$APEX/api/sites/$NAME/adopt" \
  "${auth[@]}" -H "$adopt" -d '{"token":"'"$BEARER"'"}')"
BEARER=""

# --- the end ----------------------------------------------------------------

echo
echo "delete"
check 'a credential that opens nothing' 403 "$(req GET "$APEX/api/sites/$NAME" \
  -H 'authorization: Bearer not-this-sites-token')"
check 'DELETE /api/sites/:name' 204 "$(req DELETE "$APEX/api/sites/$NAME" \
  "${auth[@]}")"
check '  the apex answers 410' 410 "$(req GET "$APEX/api/sites/$NAME" \
  "${auth[@]}")"
check '  the site host answers 410' 410 "$(req GET "$(fresh "$SITE/")")"
check '  the site database is dropped' 0 \
  "$(site_psql "select count(*) from pg_database where datname = '$NAME'")"
check '  the site role is dropped' 0 \
  "$(site_psql "select count(*) from pg_roles where rolname = '$NAME'")"

echo
echo "$pass ok, $fail failed"
[[ $fail -eq 0 ]]
