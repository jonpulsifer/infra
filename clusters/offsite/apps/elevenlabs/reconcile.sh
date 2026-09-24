#!/usr/bin/env bash
# Makes the ElevenLabs troll agent and its phone number match desired/*.json.
# With no write key it only reports drift. It logs field names, never values:
# the requests carry an API key and the trunk password, so never add `set -x`
# or print a request or response body.
set -euo pipefail

api=${ELEVENLABS_API:-https://api.elevenlabs.io}
desired=${DESIRED_DIR:-/desired}
write_key=${ELEVENLABS_WRITE_KEY:-}
read_key=${ELEVENLABS_READ_KEY:-$write_key}
failed=0

log() { printf '%s\n' "$*"; }
die() {
  log "error: $*" >&2
  exit 1
}

headers() { printf 'xi-api-key: %s\nContent-Type: application/json\n' "$1"; }

# A validation error echoes the request, password included, so only the
# failing field paths and the error status are logged. A message loses any
# run of digits long enough to be a phone number.
error_summary='
  if (.detail | type) == "array" then
    [.detail[] | ((.loc // []) | map(tostring) | join(".")) + " (" + (.type // "?") + ")"] | join(", ")
  elif (.detail | type) == "object" then
    [.detail.status, .detail.message]
    | map(select(. != null) | tostring | gsub("\\+?[0-9][0-9 ()-]{5,}[0-9]"; "<digits>") | .[:200])
    | join(": ")
  else "" end'

# call METHOD PATH KEY prints the response body. Every method but GET sends
# stdin as the body. POST is never retried: a retried create makes a second
# agent.
call() {
  local method=$1 path=$2 key=$3 out code
  local opts=(-sS --connect-timeout 10 --max-time 30 -X "$method" -w '\n%{http_code}')
  [[ $method == POST ]] || opts+=(--retry 2)
  if [[ $method == GET ]]; then
    out=$(curl "${opts[@]}" -H @<(headers "$key") "$api$path") || return 1
  else
    out=$(curl "${opts[@]}" -H @<(headers "$key") --data-binary @- "$api$path") || return 1
  fi
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [[ $code != 2?? ]]; then
    log "$method $path: HTTP $code $(jq -r "$error_summary" <<<"$out" 2>/dev/null || true)" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

# The dotted paths of every declared leaf whose live value differs. An array
# or an empty object is one leaf, compared whole.
drift() {
  jq -rn --argjson want "$1" --argjson live "$2" '
    def leaves($p):
      if type == "object" and length > 0
      then . as $o | keys_unsorted[] as $k | ($o[$k] | leaves($p + [$k]))
      else $p end;
    [$want | leaves([])]
    | map(select(. as $p | ($want | getpath($p)) != (try ($live | getpath($p)) catch {})))
    | map(map(tostring) | join("."))
    | join(", ")'
}

# Pages through every agent: the list's search is fuzzy, and an agent it
# missed would be created again on every run.
find_agent() {
  local page cursor="" ids="[]"
  for _ in {1..20}; do
    page=$(call GET "/v1/convai/agents?page_size=100${cursor:+&cursor=$cursor}" "$read_key") || return 1
    ids=$(jq -c --arg n "$1" --argjson ids "$ids" '$ids + [.agents[] | select(.name == $n) | .agent_id]' <<<"$page")
    [[ $(jq -r .has_more <<<"$page") == true ]] || break
    cursor=$(jq -r '.next_cursor | @uri' <<<"$page")
  done
  jq -r --arg n "$1" 'if length > 1 then error("more than one agent is named \($n)") else .[] end' <<<"$ids"
}

[[ -n $read_key ]] || die "no API key: the Secret elevenlabs-read-key is missing"
mode="report"
[[ -z $write_key ]] || mode="write"

want_agent=$(jq -c . "$desired/troll-agent.json")
want_number=$(jq -c . "$desired/phone-number.json")
name=$(jq -r .name <<<"$want_agent")
number_id=$(jq -r .phone_number_id <<<"$want_number")
[[ $(jq -r .agent_name <<<"$want_number") == "$name" ]] \
  || die "phone-number.json binds an agent that troll-agent.json does not declare"
log "mode: $mode"

agent_id=$(find_agent "$name") || die "could not list agents"
agent_ready=no
if [[ -z $agent_id ]]; then
  if [[ $mode == report ]]; then
    log "agent $name: would create"
  else
    created=$(call POST /v1/convai/agents/create "$write_key" <<<"$want_agent") || die "could not create agent $name"
    agent_id=$(jq -r '.agent_id // empty' <<<"$created")
    [[ -n $agent_id ]] || die "the create response named no agent"
    log "agent $name: created $agent_id"
    fields=created
  fi
else
  live=$(call GET "/v1/convai/agents/$agent_id" "$read_key") || die "could not read agent $name"
  fields=$(drift "$want_agent" "$live")
  if [[ -z $fields ]]; then
    log "agent $name ($agent_id): in sync"
    agent_ready=yes
  elif [[ $mode == report ]]; then
    log "agent $name ($agent_id): would patch $fields"
  else
    call PATCH "/v1/convai/agents/$agent_id" "$write_key" <<<"$want_agent" >/dev/null \
      || die "could not patch agent $name"
  fi
fi

# A write re-reads the agent, and binds the number only to an agent whose
# auth, call limits and tools match git.
if [[ $mode == write && $agent_ready == no ]]; then
  live=$(call GET "/v1/convai/agents/$agent_id" "$read_key") || die "could not re-read agent $name"
  left=$(drift "$want_agent" "$live")
  if [[ -n $left ]]; then
    log "agent $name ($agent_id): still differs after a write: $left"
    failed=1
  else
    [[ $fields == created ]] || log "agent $name ($agent_id): patched $fields"
    agent_ready=yes
  fi
fi

live=$(call GET "/v1/convai/phone-numbers/$number_id" "$read_key") || die "could not read number $number_id"
fields=$(jq -rn --argjson want "$want_number" --argjson live "$live" --arg agent "$agent_id" '
  $want.inbound_trunk_config as $t
  | [ (if $agent == "" or ($live.assigned_agent.agent_id // "") != $agent then "agent_id" else empty end),
      ($t | keys_unsorted[] | select($t[.] != $live.inbound_trunk[.]) | "inbound_trunk_config.\(.)"),
      (if ($live.inbound_trunk.has_auth_credentials | not) or $live.inbound_trunk.username != $ENV.TRUNK_USERNAME
       then "inbound_trunk_config.credentials" else empty end) ]
  | join(", ")')
assigned=$(jq -r '.assigned_agent.agent_id // empty' <<<"$live")
has_auth=$(jq -r '.inbound_trunk.has_auth_credentials == true' <<<"$live")
if [[ $(jq -r '.outbound_trunk != null' <<<"$live") == true ]]; then
  log "number $number_id: has an outbound trunk, which git does not declare; remove it in the ElevenLabs dashboard"
  failed=1
fi

have_creds=yes
[[ -n ${TRUNK_USERNAME:-} && -n ${TRUNK_PASSWORD:-} ]] || have_creds=no

if [[ $mode == report ]]; then
  if [[ -n $assigned && $has_auth != true ]]; then
    log "number $number_id: an agent answers it with no credentials"
    failed=1
  fi
  if [[ -z $fields ]]; then
    log "number $number_id: in sync; a write run also re-sends the password, which the API never returns"
  elif [[ $have_creds == no ]]; then
    log "number $number_id: differs in $fields; would not bind: the trunk credentials are missing"
  else
    log "number $number_id: would patch $fields"
  fi
  exit "$failed"
fi

unbind() {
  jq -n '{agent_id: null}' | call PATCH "/v1/convai/phone-numbers/$number_id" "$write_key" >/dev/null \
    || die "could not unbind number $number_id"
  log "number $number_id: unbound"
}

if [[ $have_creds == no ]]; then
  log "number $number_id: the trunk credentials are missing, so no agent is bound"
  [[ -z $assigned ]] || unbind
  exit 1
fi
if [[ $agent_ready != yes ]]; then
  log "number $number_id: not bound, because agent $name differs from git"
  [[ -z $assigned || $has_auth == true ]] || unbind
  exit 1
fi

# One PATCH carries the agent and the whole inbound trunk. The API never
# returns the password, and a partial inbound_trunk_config resets what it
# omits, so every write run re-sends all of it.
jq -n --argjson want "$want_number" --arg agent "$agent_id" '{
  agent_id: $agent,
  inbound_trunk_config: ($want.inbound_trunk_config + {
    credentials: {username: $ENV.TRUNK_USERNAME, password: $ENV.TRUNK_PASSWORD}
  })
}' | call PATCH "/v1/convai/phone-numbers/$number_id" "$write_key" >/dev/null \
  || die "could not patch number $number_id"

live=$(call GET "/v1/convai/phone-numbers/$number_id" "$read_key") || die "could not re-read number $number_id"
if [[ $(jq -r '.inbound_trunk.has_auth_credentials == true' <<<"$live") != true ]]; then
  log "number $number_id: the trunk reports no credentials after the write"
  unbind
  exit 1
fi
if [[ $(jq -r '.assigned_agent.agent_id // empty' <<<"$live") != "$agent_id" ]]; then
  log "number $number_id: agent $name is not bound after the write"
  exit 1
fi
log "number $number_id: bound to $name with credentials${fields:+ (was: $fields)}"
exit "$failed"
