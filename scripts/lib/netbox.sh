#!/usr/bin/env bash
# NetBox REST client for the drift check and the class-inputs render. Source it.
#
#   NETBOX_URL         the API's origin; default https://capsule.pirate-musical.ts.net
#   NETBOX_HOST        a Host header to send, for a loopback or ssh-forwarded URL that
#                      ALLOWED_HOSTS would reject
#   NETBOX_TOKEN       a v2 API token (nbt_<key>.<token>), or NETBOX_TOKEN_FILE naming a file
#                      that holds one; with neither, the 1Password item netbox-folly's api-token

: "${NETBOX_URL:=https://capsule.pirate-musical.ts.net}"
NETBOX_URL="${NETBOX_URL%/}"

# nb_init: read the token once, from 1Password when the environment names none. Call it before
# the first request.
nb_init() {
  if [[ -z "${NETBOX_TOKEN:-}" && -z "${NETBOX_TOKEN_FILE:-}" ]]; then
    if ! command -v op >/dev/null; then
      echo "set NETBOX_TOKEN or NETBOX_TOKEN_FILE, or install and sign in to op" >&2
      return 1
    fi
    NETBOX_TOKEN="$(op read "op://homelab/netbox-folly/api-token")"
    export NETBOX_TOKEN
  fi
}

nb_token() {
  if [[ -n "${NETBOX_TOKEN:-}" ]]; then
    printf '%s' "$NETBOX_TOKEN"
  else
    tr -d '\n' <"$NETBOX_TOKEN_FILE"
  fi
}

# nb <method> <path> [json]: one request; prints the response body. The token goes in a curl
# config on a file descriptor, never on the command line.
nb() {
  local method="$1" path="$2" body="${3:-}" token out
  token="$(nb_token)"
  local -a args=(--silent --show-error --fail-with-body --max-time 60 -X "$method"
    -H "Accept: application/json" -H "Content-Type: application/json")
  if [[ -n "${NETBOX_HOST:-}" ]]; then
    args+=(-H "Host: $NETBOX_HOST")
  fi
  if [[ -n "$body" ]]; then
    args+=(--data-binary @-)
  fi
  if ! out="$(curl "${args[@]}" -K <(printf 'header = "Authorization: Bearer %s"\n' "$token") \
    "$NETBOX_URL/api/${path#/}" <<<"$body")"; then
    echo "NetBox $method /api/${path#/} failed: $out" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

# nb_list <path?query>: every result of a list endpoint as one JSON array. It pages by offset
# because the API's `next` link names the host the request claimed to be.
nb_list() {
  local path="$1" sep="?" offset=0 page all='[]'
  [[ "$path" == *\?* ]] && sep="&"
  while :; do
    page="$(nb GET "$path${sep}limit=1000&offset=$offset")"
    all="$(jq -c --argjson page "$page" '. + $page.results' <<<"$all")"
    offset="$(jq 'length' <<<"$all")"
    [[ "$offset" -lt "$(jq '.count' <<<"$page")" ]] || break
  done
  printf '%s\n' "$all"
}
