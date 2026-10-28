#!/usr/bin/env bash
# NetBox REST client for the seed, the export and the drift check. Source it.
#
#   NETBOX_URL         the API's origin; default https://capsule.pirate-musical.ts.net
#   NETBOX_HOST        a Host header to send, for a loopback or ssh-forwarded URL that
#                      ALLOWED_HOSTS would reject
#   NETBOX_TOKEN       a v2 API token (nbt_<key>.<token>), or NETBOX_TOKEN_FILE naming a file
#                      that holds one; with neither, the 1Password item netbox-folly's api-token
#   NETBOX_CHANGES     a file that nb_ensure and its kin append one line to per write

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
    args+=(--data-binary "$body")
  fi
  if ! out="$(curl "${args[@]}" -K <(printf 'header = "Authorization: Bearer %s"\n' "$token") \
    "$NETBOX_URL/api/${path#/}")"; then
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

nb_changed() {
  echo "$1" >&2
  [[ -z "${NETBOX_CHANGES:-}" ]] || echo "$1" >>"$NETBOX_CHANGES"
}

# True when the stored object $have already holds every value of $want. A scalar matches a
# related object by its id or a choice by its value, an object matches as a subset, an array of
# objects as a subset of the stored array, and an array of scalars as a set.
# shellcheck disable=SC2016 # jq, not the shell, reads the $ names.
readonly NB_SAME='
def same($w; $h):
  if ($w | type) == "object" then
    ($h | type) == "object" and all($w | to_entries[]; . as $e | same($e.value; $h[$e.key]))
  elif ($w | type) == "array" then
    ($h | type) == "array" and
    if all($w[]; type == "object") then all($w[]; . as $x | any($h[]; same($x; .)))
    else ($w | sort) == ($h | sort) end
  elif ($h | type) == "object" then
    $w == $h.id or $w == $h.value
  else $w == $h end;
'

# nb_ensure <endpoint> <query> <json>: find the one object the query selects, create it from
# the JSON when there is none, or patch it when a value differs. A patch keeps the object's other
# tags. Prints the object's id.
nb_ensure() {
  local endpoint="${1%/}" query="$2" want="$3" found count have id patch
  found="$(nb GET "$endpoint/?$query&limit=2")"
  count="$(jq '.count' <<<"$found")"
  case "$count" in
    0)
      id="$(nb POST "$endpoint/" "$want" | jq '.id')"
      nb_changed "created $endpoint $query"
      ;;
    1)
      have="$(jq -c '.results[0]' <<<"$found")"
      id="$(jq '.id' <<<"$have")"
      if ! jq -en --argjson w "$want" --argjson h "$have" "$NB_SAME same(\$w; \$h)" >/dev/null; then
        patch="$(jq -cn --argjson w "$want" --argjson h "$have" '
          $w | if has("tags") then .tags = ([$h.tags[] | {slug}] + .tags | unique_by(.slug)) else . end')"
        nb PATCH "$endpoint/$id/" "$patch" >/dev/null
        nb_changed "updated $endpoint $query"
      fi
      ;;
    *)
      echo "$endpoint?$query selects $count objects" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$id"
}

# nb_cable <interface id> <interface id> <tags json>: one cable between the two interfaces,
# replacing any cable either end has to somewhere else.
nb_cable() {
  local a="$1" b="$2" cable_tags="$3" ai bi cable
  ai="$(nb GET "dcim/interfaces/$a/")"
  bi="$(nb GET "dcim/interfaces/$b/")"
  if jq -e --argjson b "$b" '.cable != null and any(.link_peers[]; .id == $b)' <<<"$ai" >/dev/null; then
    return 0
  fi
  for cable in $(jq -n --argjson a "$ai" --argjson b "$bi" '[$a.cable.id, $b.cable.id] | map(select(. != null)) | unique[]'); do
    nb DELETE "dcim/cables/$cable/" >/dev/null
    nb_changed "deleted dcim/cables $cable"
  done
  nb POST dcim/cables/ "$(jq -cn --argjson a "$a" --argjson b "$b" --argjson tags "$cable_tags" '{
    a_terminations: [{object_type: "dcim.interface", object_id: $a}],
    b_terminations: [{object_type: "dcim.interface", object_id: $b}],
    status: "connected",
    tags: $tags
  }')" >/dev/null
  nb_changed "created dcim/cables $(jq -r '"\(.device.name) \(.name)"' <<<"$ai") to $(jq -r '"\(.device.name) \(.name)"' <<<"$bi")"
}
