#!/usr/bin/env bash
# Makes every ElevenLabs agent under desired/agents/ and the phone number in
# desired/phone-number.json match git. With no write key it only reports
# drift. It logs field names, never values: the requests carry an API key and
# the trunk passwords, so never add `set -x` or print a request or response
# body.
set -euo pipefail

api=${ELEVENLABS_API:-https://api.elevenlabs.io}
desired=${DESIRED_DIR:-/desired}
agents_dir=${AGENTS_DIR:-$desired/agents}
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
# missed would be created again on every run. Status 1 is a failed list;
# status 2 is two live agents of one name, which git cannot choose between.
find_agent() {
  local page cursor="" ids="[]"
  for _ in {1..20}; do
    page=$(call GET "/v1/convai/agents?page_size=100${cursor:+&cursor=$cursor}" "$read_key") || return 1
    ids=$(jq -c --arg n "$1" --argjson ids "$ids" '$ids + [.agents[] | select(.name == $n) | .agent_id]' <<<"$page")
    [[ $(jq -r .has_more <<<"$page") == true ]] || break
    cursor=$(jq -r '.next_cursor | @uri' <<<"$page")
  done
  [[ $(jq length <<<"$ids") -le 1 ]] || return 2
  jq -r '.[]' <<<"$ids"
}

[[ -n $read_key ]] || die "no API key: the Secret elevenlabs-read-key is missing"
mode="report"
[[ -z $write_key ]] || mode="write"

want_number=$(jq -c . "$desired/phone-number.json")
number_id=$(jq -r .phone_number_id <<<"$want_number")
bound_name=$(jq -r .agent_name <<<"$want_number")
log "mode: $mode"

# One entry per declared agent: its live id (empty until a report run's
# "would create" happens), and whether it matches git closely enough to
# answer the number.
declare -A agent_ids=() agent_ready=()

# A request that fails for one agent fails the Job at the end and leaves that
# agent as it is: the other agents and the number's guards still run.
give_up() {
  log "$*"
  failed=1
}

# reconcile_agent NAME WANT creates or patches one agent and records it.
reconcile_agent() {
  local name=$1 want=$2 agent_id live fields left created status
  agent_ready[$name]=no
  agent_ids[$name]=""
  agent_id=$(find_agent "$name") || {
    status=$?
    [[ $status == 2 ]] || die "could not list agents"
    give_up "agent $name: more than one live agent has this name"
    return
  }
  agent_ids[$name]=$agent_id
  if [[ -z $agent_id ]]; then
    if [[ $mode == report ]]; then
      log "agent $name: would create"
      return
    fi
    created=$(call POST /v1/convai/agents/create "$write_key" <<<"$want") || {
      give_up "agent $name: not created"
      return
    }
    agent_id=$(jq -r '.agent_id // empty' <<<"$created")
    if [[ -z $agent_id ]]; then
      give_up "agent $name: the create response named no agent"
      return
    fi
    agent_ids[$name]=$agent_id
    log "agent $name: created $agent_id"
    fields=created
  else
    live=$(call GET "/v1/convai/agents/$agent_id" "$read_key") || {
      give_up "agent $name ($agent_id): not read"
      return
    }
    fields=$(drift "$want" "$live")
    if [[ -z $fields ]]; then
      log "agent $name ($agent_id): in sync"
      agent_ready[$name]=yes
      return
    fi
    if [[ $mode == report ]]; then
      log "agent $name ($agent_id): would patch $fields"
      return
    fi
    call PATCH "/v1/convai/agents/$agent_id" "$write_key" <<<"$want" >/dev/null || {
      give_up "agent $name ($agent_id): not patched"
      return
    }
  fi

  # A write re-reads the agent, and the number binds only to an agent whose
  # auth, call limits and tools match git.
  live=$(call GET "/v1/convai/agents/$agent_id" "$read_key") || {
    give_up "agent $name ($agent_id): not re-read"
    return
  }
  left=$(drift "$want" "$live")
  if [[ -n $left ]]; then
    give_up "agent $name ($agent_id): still differs after a write: $left"
    return
  fi
  [[ $fields == created ]] || log "agent $name ($agent_id): patched $fields"
  agent_ready[$name]=yes
}

agent_files=("$agents_dir"/*.json)
[[ -e ${agent_files[0]} ]] || die "$agents_dir declares no agent"
for file in "${agent_files[@]}"; do
  want_agent=$(jq -c . "$file")
  name=$(jq -r '.name // empty' <<<"$want_agent")
  [[ -n $name ]] || die "$(basename "$file") names no agent"
  [[ ! -v agent_ids[$name] ]] || die "two files under $agents_dir name the agent $name"
  reconcile_agent "$name" "$want_agent"
done

[[ -v agent_ids[$bound_name] ]] \
  || die "phone-number.json binds an agent that $agents_dir does not declare"
agent_id=${agent_ids[$bound_name]}
bound_ready=${agent_ready[$bound_name]}

have_creds=yes
[[ -n ${TRUNK_USERNAME:-} && -n ${TRUNK_PASSWORD:-} ]] || have_creds=no
have_out=yes
[[ -n ${OUTBOUND_TRUNK_USERNAME:-} && -n ${OUTBOUND_TRUNK_PASSWORD:-} ]] || have_out=no

# The outbound trunk is compared and sent only with its credentials in hand:
# git declares the address and transport, and the 1Password item holds the
# sub-account it dials out on.
want_out=$(jq -c '.outbound_trunk_config // empty' <<<"$want_number")
out_cfg=null
[[ -z $want_out || $have_out == no ]] || out_cfg=$want_out

live=$(call GET "/v1/convai/phone-numbers/$number_id" "$read_key") || die "could not read number $number_id"
fields=$(jq -rn --argjson want "$want_number" --argjson live "$live" --arg agent "$agent_id" --argjson out "$out_cfg" '
  $want.inbound_trunk_config as $t
  | [ (if $agent == "" or ($live.assigned_agent.agent_id // "") != $agent then "agent_id" else empty end),
      ($t | keys_unsorted[] | select($t[.] != $live.inbound_trunk[.]) | "inbound_trunk_config.\(.)"),
      (if ($live.inbound_trunk.has_auth_credentials | not) or $live.inbound_trunk.username != $ENV.TRUNK_USERNAME
       then "inbound_trunk_config.credentials" else empty end),
      (($out // {}) | keys_unsorted[] | select($out[.] != $live.outbound_trunk[.]) | "outbound_trunk_config.\(.)"),
      (if $out != null and (($live.outbound_trunk.has_auth_credentials // false | not)
                            or $live.outbound_trunk.username != $ENV.OUTBOUND_TRUNK_USERNAME)
       then "outbound_trunk_config.credentials" else empty end) ]
  | join(", ")')
assigned=$(jq -r '.assigned_agent.agent_id // empty' <<<"$live")
has_auth=$(jq -r '.inbound_trunk.has_auth_credentials == true' <<<"$live")
live_out=$(jq -r '.outbound_trunk != null' <<<"$live")

if [[ -z $want_out && $live_out == true ]]; then
  log "number $number_id: has an outbound trunk, which git does not declare; remove it in the ElevenLabs dashboard"
  failed=1
elif [[ -n $want_out && $have_out == no ]]; then
  log "number $number_id: the outbound trunk waits for the 1Password item elevenlabs outbound trunk"
  # A trunk whose password git cannot re-send is one it cannot own.
  if [[ $live_out == true ]]; then
    log "number $number_id: has an outbound trunk with no credentials in git; remove it in the ElevenLabs dashboard"
    failed=1
  fi
fi

if [[ $mode == report ]]; then
  if [[ -n $assigned && $has_auth != true ]]; then
    log "number $number_id: an agent answers it with no credentials"
    failed=1
  fi
  if [[ -z $fields ]]; then
    log "number $number_id: in sync; a write run also re-sends each password, which the API never returns"
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
if [[ $bound_ready != yes ]]; then
  log "number $number_id: not bound, because agent $bound_name differs from git"
  [[ -z $assigned || $has_auth == true ]] || unbind
  exit 1
fi

# One PATCH carries the agent, the full inbound trunk and, with its
# credentials in hand, the full outbound trunk. The API never returns a
# password, and a partial trunk config resets what it omits, so every write
# run re-sends all of it.
jq -n --argjson want "$want_number" --arg agent "$agent_id" --argjson out "$out_cfg" '{
  agent_id: $agent,
  inbound_trunk_config: ($want.inbound_trunk_config + {
    credentials: {username: $ENV.TRUNK_USERNAME, password: $ENV.TRUNK_PASSWORD}
  })
} + (if $out == null then {} else {
  outbound_trunk_config: ($out + {
    credentials: {username: $ENV.OUTBOUND_TRUNK_USERNAME, password: $ENV.OUTBOUND_TRUNK_PASSWORD}
  })
} end)' | call PATCH "/v1/convai/phone-numbers/$number_id" "$write_key" >/dev/null \
  || die "could not patch number $number_id"

live=$(call GET "/v1/convai/phone-numbers/$number_id" "$read_key") || die "could not re-read number $number_id"
if [[ $(jq -r '.inbound_trunk.has_auth_credentials == true' <<<"$live") != true ]]; then
  log "number $number_id: the trunk reports no credentials after the write"
  unbind
  exit 1
fi
if [[ $(jq -r '.assigned_agent.agent_id // empty' <<<"$live") != "$agent_id" ]]; then
  log "number $number_id: agent $bound_name is not bound after the write"
  exit 1
fi
# out_cfg is the JSON null, a non-empty string, so it needs a test of its own.
out_note=""
if [[ $out_cfg != null ]]; then
  out_note=" and an outbound trunk"
  if [[ $(jq -r '.outbound_trunk.has_auth_credentials == true' <<<"$live") != true ]]; then
    log "number $number_id: the outbound trunk reports no credentials after the write"
    failed=1
  fi
fi
log "number $number_id: bound to $bound_name with credentials${out_note}${fields:+ (was: $fields)}"
exit "$failed"
