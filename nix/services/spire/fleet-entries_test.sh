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
# nodes <nodes> [<revoked>]
nodes() { jq -n --argjson n "$1" --argjson r "${2:-[]}" '{nodes: $n, revoked: $r}' >"$NODES_FILE"; }
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
fpS=$(printf '5%.0s' {1..40})
fpOld=$(printf '6%.0s' {1..40})

riptide='{"name":"riptide","ek_hashes":["'"$hashA"'"]}'
surge='{"name":"surge","ek_hashes":["'"$hashB"'"]}'
agents='[["/spire/agent/tpm_devid/r1","tpm_devid:subject:cn:riptide"],["/spire/agent/tpm_devid/'"$fpS"'","tpm_devid:subject:cn:surge"]]'
s1=/spire/agent/tpm_devid/$fpS

state '[]' "$agents"
nodes "[$riptide,$surge]"
apply
check "registers each listed node by CN and EK hash, with its workloads" \
  '[ "$rc" = 0 ] && [ "$(issued /node/riptide /spire/server)" = 2 ] && [ "$(issued /node/surge /spire/server)" = 2 ] && [ "$(issued /ns/spire-test/sa/uploader /node/surge)" = 1 ]'
apply
check "a second run changes nothing" '[ "$rc" = 0 ] && [ ! -s "$LOG" ]'

nodes "[$riptide]"
apply
check "a withdrawn node loses its entries, and its agent is banned" \
  '[ "$rc" = 0 ] && [ "$(issued /node/surge /spire/server)" = 0 ] && [ "$(issued /ns/spire-test/sa/uploader /node/surge)" = 0 ] && [ "$(agent "$s1")" = banned ] && [ "$(agent /spire/agent/tpm_devid/r1)" = live ]'
apply
check "a banned agent is not banned again" '[ "$rc" = 0 ] && [ ! -s "$LOG" ]'

nodes "[$riptide,$surge]"
apply
check "a node registered again has its banned agent evicted, so it attests again" \
  '[ "$rc" = 0 ] && [ "$(issued /node/surge /spire/server)" = 2 ] && [ -z "$(agent "$s1")" ] && grep -qx "evict spiffe://lolwtf.ca$s1" "$LOG"'

state '[]' "$agents"
nodes "[$riptide,$surge]"
apply
nodes '[]'
cp "$STATE" "$tmp/before"
apply
check "withdrawing two nodes in one run is refused and changes nothing" \
  '[ "$rc" = 1 ] && grep -q "refusing to withdraw or ban 2 nodes" "$tmp/out" && [ ! -s "$LOG" ] && cmp -s "$STATE" "$tmp/before"'

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
check "an agent whose selector a git- entry still carries is not banned" \
  '[ "$rc" = 0 ] && [ "$(issued /node/surge /spire/server)" = 1 ] && [ "$(agent "$s1")" = live ]'
nodes "[$riptide]" '[{"name":"surge","ek_hashes":["'"$hashB"'"],"ldevids":["'"$fpS"'"]}]'
apply
check "a revoked node's agent is banned even while a git- entry carries its selector" \
  '[ "$rc" = 0 ] && [ "$(agent "$s1")" = banned ] && [ "$(issued /node/surge /spire/server)" = 1 ]'

state '[]' "$agents"
jq '.agents += [
  {id: {trust_domain: "lolwtf.ca", path: "/spire/agent/tpm_devid/'"$fpOld"'"}, selectors: [{type: "tpm_devid", value: "subject:cn:surge"}], banned: false},
  {id: {trust_domain: "lolwtf.ca", path: "/spire/agent/tpm/'"$hashB"'"}, selectors: [{type: "tpm", value: "pub_hash:'"$hashB"'"}], banned: false}]' \
  "$STATE" >"$tmp/s" && mv "$tmp/s" "$STATE"
nodes "[$riptide]" '[{"name":"surge","ek_hashes":["'"$hashB"'"],"ldevids":[]}]'
apply
check "a revoked node's agents are banned by its CN and its EK hash, whatever LDevID they hold" \
  '[ "$rc" = 0 ] && [ "$(agent "$s1")" = banned ] && [ "$(agent /spire/agent/tpm_devid/$fpOld)" = banned ] && [ "$(agent /spire/agent/tpm/$hashB)" = banned ] && [ "$(agent /spire/agent/tpm_devid/r1)" = live ]'
nodes "[$riptide]" '[{"name":"surge","ek_hashes":[],"ldevids":[]}]'
apply
check "a revoked node's banned agent stays banned" '[ "$rc" = 0 ] && [ "$(agent "$s1")" = banned ] && [ ! -s "$LOG" ]'

state '[]' "$agents"
nodes '[]' '[{"name":"riptide","ek_hashes":[],"ldevids":[]},{"name":"surge","ek_hashes":[],"ldevids":[]}]'
apply
check "revoking two nodes with live agents in one run is refused" \
  '[ "$rc" = 1 ] && grep -q "refusing to withdraw or ban 2 nodes" "$tmp/out" && [ ! -s "$LOG" ]'

state '[]' "$agents"
printf '{"nodes":[%s]}' "$riptide" >"$NODES_FILE"
apply
check "a file with no revoked list is read" '[ "$rc" = 0 ] && [ "$(issued /node/riptide /spire/server)" = 2 ]'

for bad in \
  '{"nodes":[{"name":"Bad Name","ek_hashes":[]}]}' \
  '{"nodes":[],"extra":1}' \
  '{"nodes":[],"revoked":null}' \
  '{"nodes":[{"name":"a","ek_hashes":["xyz"]}]}' \
  '{"nodes":[],"revoked":[{"name":"a","ek_hashes":[],"ldevids":["XYZ"]}]}' \
  '{"nodes":[],"revoked":[{"name":"a","ek_hashes":[]}]}' \
  '{"nodes":[{"name":"a","ek_hashes":[]}],"revoked":[{"name":"a","ek_hashes":[],"ldevids":[]}]}' \
  '{"nodes":[{"name":"a","ek_hashes":["'"$hashA"'"]}],"revoked":[{"name":"b","ek_hashes":["'"$hashA"'"],"ldevids":[]}]}'; do
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
