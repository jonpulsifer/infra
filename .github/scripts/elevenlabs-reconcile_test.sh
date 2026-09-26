#!/usr/bin/env bash
# Runs clusters/offsite/apps/elevenlabs/reconcile.sh against the desired files
# in git with `curl` stubbed: the stub answers each ElevenLabs endpoint from a
# fixture directory and logs the shape of every request, never a value.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
app="$here/../../clusters/offsite/apps/elevenlabs"
script="$app/reconcile.sh"
desired="$app/desired"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_equal() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nexpected:\n%s\nactual:\n%s\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL: %s\nexpected to contain:\n%s\nactual:\n%s\n' "$name" "$needle" "$haystack" >&2
    exit 1
  fi
}

assert_lacks() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'FAIL: %s\nexpected not to contain:\n%s\nactual:\n%s\n' "$name" "$needle" "$haystack" >&2
    exit 1
  fi
}

stubs="$work/stubs"
mkdir -p "$stubs"

# The URL is the last argument and the body arrives on stdin, the way
# reconcile.sh's call() invokes curl. A PATCH updates the fixture the way the
# API would read it back: a password becomes has_auth_credentials, and with
# STUB_DROP_AUTH=1 the inbound trunk reads back without it, the way a rejected
# credential does.
cat >"$stubs/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
method=GET body="" key=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case ${args[i]} in
    -X) method=${args[i + 1]} ;;
    -H) key=$(sed -n 's/^xi-api-key: //p' "${args[i + 1]#@}" 2>/dev/null || true) ;;
    --data-binary) body=$(cat) ;;
  esac
done
url=${args[-1]}
path=${url#*://}
path=/${path#*/}
path=${path%%\?*}

# A null leaf is part of the shape: the unbind body is {agent_id: null}.
shape=""
[[ -z $body ]] || shape=$(jq -r '[paths(type != "object" and type != "array") | map(tostring) | join(".")] | join(" ")' <<<"$body")
printf '%s %s key=%s %s\n' "$method" "$path" "$key" "$shape" >>"$STUB_LOG"

respond() { printf '%s\n%s' "$1" "$2"; }
trunk='del(.credentials) + {has_auth_credentials: (.credentials != null), username: (.credentials.username // null)}'

case "$method $path" in
  "GET /v1/convai/agents")
    respond "$(cat "$STUB_DIR/agents.json")" 200
    ;;
  "GET /v1/convai/agents/"*)
    file="$STUB_DIR/agent-${path##*/}.json"
    if [[ -f $file ]]; then
      respond "$(cat "$file")" 200
    else
      respond '{"detail":{"status":"not_found","message":"no such agent"}}' 404
    fi
    ;;
  "POST /v1/convai/agents/create")
    if [[ ${STUB_CREATE_STATUS:-200} != 200 ]]; then
      respond '{"detail":[{"loc":["body","conversation_config","tts","voice_id"],"type":"value_error"}]}' "$STUB_CREATE_STATUS"
    else
      jq --arg id agent_new '. + {agent_id: $id}' <<<"$body" >"$STUB_DIR/agent-agent_new.json"
      respond '{"agent_id":"agent_new"}' 200
    fi
    ;;
  "PATCH /v1/convai/agents/"*)
    jq --arg id "${path##*/}" '. + {agent_id: $id}' <<<"$body" >"$STUB_DIR/agent-${path##*/}.json"
    respond '{}' 200
    ;;
  "GET /v1/convai/phone-numbers/"*)
    respond "$(cat "$STUB_DIR/number.json")" 200
    ;;
  "PATCH /v1/convai/phone-numbers/"*)
    jq --argjson b "$body" "
      .assigned_agent = (if (\$b | has(\"agent_id\")) then (if \$b.agent_id == null then null else {agent_id: \$b.agent_id} end) else .assigned_agent end)
      | .inbound_trunk = (if \$b.inbound_trunk_config == null then .inbound_trunk
                          else (\$b.inbound_trunk_config | $trunk | .has_auth_credentials = (.has_auth_credentials and \$ENV.STUB_DROP_AUTH != \"1\")) end)
      | .outbound_trunk = (if \$b.outbound_trunk_config == null then .outbound_trunk else (\$b.outbound_trunk_config | $trunk) end)
    " "$STUB_DIR/number.json" >"$STUB_DIR/number.next.json"
    mv "$STUB_DIR/number.next.json" "$STUB_DIR/number.json"
    respond '{}' 200
    ;;
  *)
    respond '{"detail":{"status":"not_found","message":"no such route"}}' 404
    ;;
esac
STUB
chmod +x "$stubs/curl"
export PATH="$stubs:$PATH"

# The live account as the fixtures start: the troll agent exists and matches
# git, the number is bound to it with inbound credentials and has no outbound
# trunk. Every case starts from a fresh copy.
pristine="$work/pristine"
mkdir -p "$pristine"
number_id=$(jq -r .phone_number_id "$desired/phone-number.json")
jq -n '{agents: [{agent_id: "agent_troll1", name: "pbx-troll"}, {agent_id: "agent_other", name: "rowbutt"}], has_more: false}' \
  >"$pristine/agents.json"
jq '. + {agent_id: "agent_troll1"}' "$desired/agents/pbx-troll.json" >"$pristine/agent-agent_troll1.json"
jq '{phone_number_id, assigned_agent: {agent_id: "agent_troll1"},
     inbound_trunk: (.inbound_trunk_config + {has_auth_credentials: true, username: "in-user"}),
     outbound_trunk: null}' "$desired/phone-number.json" >"$pristine/number.json"

export STUB_DIR="$work/live" STUB_LOG="$work/requests.log"

# run_case DESIRED_DIR [VAR=value]... runs the reconciler once from fresh
# fixtures, into $out (both streams), $status and $requests.
run_case() {
  local dir=$1
  shift
  rm -rf "$STUB_DIR"
  cp -r "$pristine" "$STUB_DIR"
  : >"$STUB_LOG"
  status=0
  out=$(env -u ELEVENLABS_READ_KEY -u ELEVENLABS_WRITE_KEY \
    -u TRUNK_USERNAME -u TRUNK_PASSWORD -u OUTBOUND_TRUNK_USERNAME -u OUTBOUND_TRUNK_PASSWORD \
    -u STUB_CREATE_STATUS -u STUB_DROP_AUTH \
    ELEVENLABS_API=http://stub DESIRED_DIR="$dir" "$@" bash "$script" 2>&1) || status=$?
  requests=$(cat "$STUB_LOG")
}

write_env=(ELEVENLABS_READ_KEY=read-key ELEVENLABS_WRITE_KEY=write-key TRUNK_USERNAME=in-user TRUNK_PASSWORD=in-pass)

run_case "$desired" ELEVENLABS_READ_KEY=read-key
assert_equal 'report mode exits 0 when nothing is wrong live' 0 "$status"
assert_contains 'report mode says what it would create' "$out" 'agent pbx-switchboard: would create'
assert_contains 'report mode reads the troll agent as in sync' "$out" 'agent pbx-troll (agent_troll1): in sync'
assert_contains 'report mode names the Secret the outbound trunk waits for' "$out" \
  "number $number_id: the outbound trunk waits for the Secret elevenlabs-outbound-trunk"
assert_contains 'report mode does not bind without the inbound credentials' "$out" 'would not bind: the trunk credentials are missing'
assert_lacks 'report mode sends no POST' "$requests" 'POST '
assert_lacks 'report mode sends no PATCH' "$requests" 'PATCH '

run_case "$desired" "${write_env[@]}"
assert_equal 'a write run without the outbound item exits 0' 0 "$status"
assert_contains 'a write run creates the missing agent' "$out" 'agent pbx-switchboard: created agent_new'
assert_contains 'a write run creates with the write key' "$requests" 'POST /v1/convai/agents/create key=write-key'
assert_contains 'a write run re-sends the inbound credentials' "$requests" \
  "PATCH /v1/convai/phone-numbers/$number_id key=write-key"
patch=$(grep "PATCH /v1/convai/phone-numbers/$number_id" <<<"$requests")
assert_contains 'the number PATCH carries the inbound password' "$patch" 'inbound_trunk_config.credentials.password'
assert_lacks 'the number PATCH carries no outbound trunk without its item' "$patch" 'outbound_trunk_config'
assert_equal 'the final line claims no outbound trunk when none was sent' \
  "number $number_id: bound to pbx-troll with credentials" "$(tail -n1 <<<"$out")"

run_case "$desired" "${write_env[@]}" STUB_DROP_AUTH=1
assert_equal 'a trunk that reads back without credentials fails the Job' 1 "$status"
assert_contains 'a trunk that reads back without credentials is named' "$out" \
  "number $number_id: the trunk reports no credentials after the write"
assert_contains 'a trunk that reads back without credentials is unbound' "$out" "number $number_id: unbound"
assert_lacks 'a trunk that reads back without credentials is not reported bound' "$out" 'bound to pbx-troll'
assert_equal 'the unbind is the second number PATCH' 2 "$(grep -c "PATCH /v1/convai/phone-numbers/$number_id" <<<"$requests")"
assert_equal 'the unbind PATCH carries only agent_id' \
  "PATCH /v1/convai/phone-numbers/$number_id key=write-key agent_id" \
  "$(grep "PATCH /v1/convai/phone-numbers/$number_id" <<<"$requests" | tail -n1)"
assert_equal 'the unbind leaves the number with no agent' null "$(jq -r .assigned_agent "$STUB_DIR/number.json")"

run_case "$desired" ELEVENLABS_READ_KEY=read-key ELEVENLABS_WRITE_KEY=write-key
assert_equal 'a write run without the inbound item fails the Job' 1 "$status"
assert_contains 'a write run without the inbound item binds no agent' "$out" \
  "number $number_id: the trunk credentials are missing, so no agent is bound"
assert_contains 'a write run without the inbound item unbinds the number' "$out" "number $number_id: unbound"
assert_equal 'a write run without the inbound item sends one number PATCH, carrying only agent_id' \
  "PATCH /v1/convai/phone-numbers/$number_id key=write-key agent_id" \
  "$(grep "PATCH /v1/convai/phone-numbers/$number_id" <<<"$requests")"
assert_equal 'the unbind leaves the number with no agent' null "$(jq -r .assigned_agent "$STUB_DIR/number.json")"

run_case "$desired" "${write_env[@]}" OUTBOUND_TRUNK_USERNAME=out-user OUTBOUND_TRUNK_PASSWORD=out-pass
assert_equal 'a write run with the outbound item exits 0' 0 "$status"
patch=$(grep "PATCH /v1/convai/phone-numbers/$number_id" <<<"$requests")
assert_contains 'the number PATCH carries the outbound trunk and its password' "$patch" 'outbound_trunk_config.credentials.password'
assert_contains 'the number PATCH carries the outbound address' "$patch" 'outbound_trunk_config.address'
assert_contains 'the final line reports the outbound trunk' "$(tail -n1 <<<"$out")" \
  "number $number_id: bound to pbx-troll with credentials and an outbound trunk (was: outbound_trunk_config."
assert_lacks 'no log line carries a password' "$out" 'out-pass'
assert_lacks 'no request log line carries a password' "$requests" 'out-pass'

jq '.outbound_trunk = {address: "montreal10.voip.ms", transport: "tls", has_auth_credentials: true, username: "someone"}' \
  "$pristine/number.json" >"$pristine/number.live-out.json"
mv "$pristine/number.json" "$pristine/number.no-out.json"
mv "$pristine/number.live-out.json" "$pristine/number.json"
run_case "$desired" "${write_env[@]}"
assert_equal 'a live outbound trunk without its item fails the Job' 1 "$status"
assert_contains 'a live outbound trunk without its item is named' "$out" \
  "number $number_id: has an outbound trunk with no credentials in git; remove it in the ElevenLabs dashboard"
assert_lacks 'the final line does not claim the trunk git could not send' "$(tail -n1 <<<"$out")" 'and an outbound trunk'
mv "$pristine/number.no-out.json" "$pristine/number.json"

run_case "$desired" "${write_env[@]}" STUB_CREATE_STATUS=422
assert_equal 'a failed create fails the Job' 1 "$status"
assert_contains 'a failed create logs the field at fault and no value' "$out" \
  'POST /v1/convai/agents/create: HTTP 422 body.conversation_config.tts.voice_id (value_error)'
assert_contains 'a failed create names the agent' "$out" 'agent pbx-switchboard: not created'
assert_contains 'the other agent is still reconciled after a failed create' "$out" 'agent pbx-troll (agent_troll1): in sync'
assert_contains 'the number is still reconciled after a failed create' "$requests" "PATCH /v1/convai/phone-numbers/$number_id"
assert_equal 'the number is still bound after a failed create' \
  "number $number_id: bound to pbx-troll with credentials" "$(tail -n1 <<<"$out")"

jq '.agents += [{agent_id: "agent_troll2", name: "pbx-troll"}]' "$pristine/agents.json" >"$pristine/agents.two.json"
mv "$pristine/agents.json" "$pristine/agents.one.json"
mv "$pristine/agents.two.json" "$pristine/agents.json"
run_case "$desired" "${write_env[@]}"
assert_equal 'two live agents of one name fail the Job' 1 "$status"
assert_contains 'two live agents of one name are named' "$out" 'agent pbx-troll: more than one live agent has this name'
assert_lacks 'two live agents of one name are not a failed list' "$out" 'could not list agents'
assert_contains 'the other agent is still reconciled after a duplicated name' "$out" 'agent pbx-switchboard: created agent_new'
assert_contains 'the number is still guarded after a duplicated name' "$out" \
  "number $number_id: not bound, because agent pbx-troll differs from git"
assert_lacks 'the number is not bound to a guessed agent' "$requests" "PATCH /v1/convai/phone-numbers/$number_id"
mv "$pristine/agents.one.json" "$pristine/agents.json"

undeclared="$work/undeclared"
cp -r "$desired" "$undeclared"
jq '.agent_name = "nobody"' "$desired/phone-number.json" >"$undeclared/phone-number.json"
run_case "$undeclared" "${write_env[@]}"
assert_equal 'a number bound to an undeclared agent fails before any write' 1 "$status"
assert_contains 'a number bound to an undeclared agent is refused' "$out" 'binds an agent that'
assert_lacks 'a number bound to an undeclared agent sends no PATCH' "$requests" 'PATCH '

echo "elevenlabs-reconcile_test: ok"
