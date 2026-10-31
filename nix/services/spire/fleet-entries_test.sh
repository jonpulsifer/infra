#!/usr/bin/env bash
# Runs the fleetd entry applier against a stub spire-server CLI that keeps its entries and agents in
# a JSON file, and checks what each run changes. check evaluates its condition after the run, so
# the conditions are single-quoted and read rc there.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export STATE=$tmp/state.json LOG=$tmp/log
export SPIRE_SERVER=$tmp/spire-server SPIRE_SOCKET=$tmp/api.sock NODES_FILE=$tmp/spire-nodes.json
export TRUST_DOMAIN=lolwtf.ca MAX_WITHDRAWALS=1 WITHDRAW_OVERRIDE=$tmp/withdraw
export WORKLOADS='[{"ns":"spire-oidc","sa":"oidc-discovery-provider"},{"ns":"spire-test","sa":"uploader"}]'

cat >"$SPIRE_SERVER" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
sp() { jq -n --arg p "${1#spiffe://lolwtf.ca}" '{trust_domain: "lolwtf.ca", path: $p}'; }
mutate() { jq "$@" "$STATE" >"$STATE.t" && mv "$STATE.t" "$STATE"; }
case "$1 $2" in
  "healthcheck -socketPath") ;;
  "entry show") jq '{entries}' "$STATE" ;;
  "agent list") jq '{agents}' "$STATE" ;;
  "entry create")
    shift 2
    id= spiffe= parent= sels='[]'
    while [ "$#" -gt 0 ]; do
      case $1 in
        -entryID) id=$2 ;;
        -spiffeID) spiffe=$2 ;;
        -parentID) parent=$2 ;;
        -selector) sels=$(jq -c --arg s "$2" '. + [{type: ($s | split(":")[0]), value: ($s | split(":")[1:] | join(":"))}]' <<<"$sels") ;;
      esac
      shift 2
    done
    mutate --arg id "$id" --argjson s "$(sp "$spiffe")" --argjson p "$(sp "$parent")" --argjson sels "$sels" \
      '.entries += [{id: $id, spiffe_id: $s, parent_id: $p, selectors: $sels}]'
    echo "create $spiffe <- $parent" >>"$LOG"
    ;;
  "entry delete")
    mutate --arg id "$4" '.entries |= map(select(.id != $id))'
    echo "delete $4" >>"$LOG"
    ;;
  "agent evict")
    mutate --arg p "${4#spiffe://lolwtf.ca}" '.agents |= map(select(.id.path != $p))'
    echo "evict $4" >>"$LOG"
    ;;
  "agent ban")
    mutate --arg p "${4#spiffe://lolwtf.ca}" '.agents |= map(if .id.path == $p then .banned = true else . end)'
    echo "ban $4" >>"$LOG"
    ;;
  *)
    echo "stub: unsupported $*" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$SPIRE_SERVER"

hashA=$(printf 'a%.0s' {1..64})
hashB=$(printf 'b%.0s' {1..64})
failures=0

# state <entries> <agents>: an entry is [id, spiffe path, parent path, selectors...] and an agent
# is [id path, selectors...].
state() {
  jq -n --argjson e "$1" --argjson a "$2" '
    def sp: {trust_domain: "lolwtf.ca", path: .};
    def sel: split(":") | {type: .[0], value: (.[1:] | join(":"))};
    {entries: [$e[] | {id: .[0], spiffe_id: (.[1] | sp), parent_id: (.[2] | sp), selectors: [.[3:][] | sel]}],
     agents: [$a[] | {id: (.[0] | sp), selectors: [.[1:][] | sel], banned: false}]}' >"$STATE"
}
nodes() { jq -n --argjson n "$1" '{nodes: $n}' >"$NODES_FILE"; }
apply() {
  : >"$LOG"
  rc=0
  "$here/fleet-entries.sh" >"$tmp/out" 2>&1 || rc=$?
}
check() {
  if eval "$2"; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    sed 's/^/     /' "$tmp/out" "$LOG"
    failures=$((failures + 1))
  fi
}
# issued <spiffe path> <parent path>: how many entries issue it.
issued() { jq --arg s "$1" --arg p "$2" '[.entries[] | select(.spiffe_id.path == $s and .parent_id.path == $p)] | length' "$STATE"; }
agent() { jq -r --arg p "$1" '.agents[] | select(.id.path == $p) | if .banned then "banned" else "live" end' "$STATE"; }

riptide='{"name":"riptide","ek_hashes":["'$hashA'"]}'
surge='{"name":"surge","ek_hashes":["'$hashB'"]}'
agents='[["/spire/agent/tpm_devid/r1","tpm_devid:subject:cn:riptide"],["/spire/agent/tpm_devid/s1","tpm_devid:subject:cn:surge"]]'

state '[]' "$agents"
nodes "[$riptide,$surge]"
apply
check "registers each listed node by CN and EK hash, with its workloads" \
  '[ "$rc" = 0 ] && [ "$(issued /node/riptide /spire/server)" = 2 ] && [ "$(issued /node/surge /spire/server)" = 2 ] && [ "$(issued /ns/spire-test/sa/uploader /node/surge)" = 1 ]'
apply
check "a second run changes nothing" '[ "$rc" = 0 ] && [ ! -s "$LOG" ]'

nodes "[$riptide]"
apply
check "a withdrawn node loses its entries and its agent" \
  '[ "$rc" = 0 ] && [ "$(issued /node/surge /spire/server)" = 0 ] && [ "$(issued /ns/spire-test/sa/uploader /node/surge)" = 0 ] && [ -z "$(agent /spire/agent/tpm_devid/s1)" ] && [ "$(agent /spire/agent/tpm_devid/r1)" = live ]'

state '[]' "$agents"
nodes "[$riptide,$surge]"
apply
nodes '[]'
cp "$STATE" "$tmp/before"
apply
check "withdrawing two nodes in one run is refused and changes nothing" \
  '[ "$rc" = 1 ] && grep -q "refusing to withdraw 2 nodes" "$tmp/out" && [ ! -s "$LOG" ] && cmp -s "$STATE" "$tmp/before"'

printf 'riptide\n' >"$WITHDRAW_OVERRIDE"
apply
check "an override that names one of two leaves one over the cap, which the cap allows" \
  '[ "$rc" = 0 ] && [ "$(issued /node/riptide /spire/server)" = 0 ] && [ "$(issued /node/surge /spire/server)" = 0 ] && [ ! -e "$WITHDRAW_OVERRIDE" ]'

state '[]' "$agents"
nodes "[$riptide,$surge]"
apply
nodes '[]'
MAX_WITHDRAWALS=0 apply
check "with no override, a run over the cap fails" '[ "$rc" = 1 ] && [ ! -s "$LOG" ]'
printf 'riptide\nsurge\n' >"$WITHDRAW_OVERRIDE"
MAX_WITHDRAWALS=0 apply
check "an override that names every node lifts the cap once" \
  '[ "$rc" = 0 ] && [ "$(issued /node/surge /spire/server)" = 0 ] && [ ! -e "$WITHDRAW_OVERRIDE" ]'

state '[["git-1","/node/surge","/spire/server","tpm_devid:subject:cn:surge"]]' "$agents"
nodes "[$riptide,$surge]"
apply
check "an entry a git- entry issues is not made again" \
  '[ "$(issued /node/surge /spire/server)" = 2 ] && [ "$(jq "[.entries[] | select(.id | startswith(\"fleet-\")) | select(.spiffe_id.path == \"/node/surge\" and .selectors[0].type == \"tpm_devid\")] | length" "$STATE")" = 0 ]'
nodes "[$riptide]"
apply
check "an agent whose selector a git- entry still carries stays" \
  '[ "$rc" = 0 ] && [ "$(issued /node/surge /spire/server)" = 1 ] && [ "$(agent /spire/agent/tpm_devid/s1)" = live ]'

for bad in '{"nodes":[{"name":"Bad Name","ek_hashes":[]}]}' '{"nodes":[],"extra":1}' '{"nodes":[{"name":"a","ek_hashes":["xyz"]}]}'; do
  state '[]' "$agents"
  nodes "[$riptide]"
  apply
  printf '%s' "$bad" >"$NODES_FILE"
  cp "$STATE" "$tmp/before"
  apply
  check "a malformed file changes nothing: $bad" '[ "$rc" = 1 ] && [ ! -s "$LOG" ] && cmp -s "$STATE" "$tmp/before"'
done

[ "$failures" = 0 ] || {
  echo "$failures failed"
  exit 1
}
