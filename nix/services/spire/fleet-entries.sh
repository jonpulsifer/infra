#!/usr/bin/env bash
# The fleetd entry applier. spire-server-fleet-entries in nix/services/spire-server.nix runs it as
# root on the SPIRE server's socket. It registers the nodes in $NODES_FILE as `fleet-*` entries and
# withdraws the nodes that leave the file. docs/platform/identity.md has the design.
set -euo pipefail

: "${SPIRE_SERVER:?}" "${SPIRE_SOCKET:?}" "${NODES_FILE:?}" "${TRUST_DOMAIN:?}" "${WORKLOADS:?}"
: "${MAX_WITHDRAWALS:?}" "${WITHDRAW_OVERRIDE:?}"

srv() { "$SPIRE_SERVER" "$@" -socketPath "$SPIRE_SOCKET"; }
file=$NODES_FILE
server=spiffe://$TRUST_DOMAIN/spire/server
nodePrefix=spiffe://$TRUST_DOMAIN/node/
# The key of an entry from `entry show -output json`: "<parent> <spiffe id> <sorted selectors>".
defs='
  def sid: "spiffe://\(.trust_domain)\(.path)";
  def sels: [.selectors[]? | "\(.type):\(.value)"];
  def ekey: "\(.parent_id | sid) \(.spiffe_id | sid) \(sels | sort | join(","))";
'

for _ in $(seq 60); do
  srv healthcheck >/dev/null 2>&1 && break
  sleep 1
done
srv healthcheck

[ -e "$file" ] || {
  echo "no $file; nothing to apply"
  exit 0
}

# A file that is not exactly this shape changes nothing.
jq -e '
  type == "object" and keys == ["nodes"] and (.nodes | type == "array")
  and all(.nodes[]; type == "object" and keys == ["ek_hashes", "name"]
    and (.name | type == "string" and test("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"))
    and (.ek_hashes | type == "array" and all(.[]; type == "string" and test("^[0-9a-f]{64}$"))))
  and ([.nodes[].name] | length == (unique | length))' "$file" >/dev/null || {
  echo "$file is malformed; the entries stay as they are" >&2
  exit 1
}

# Every entry the file asks for, one JSON object a line.
desired=$(jq -c --arg server "$server" --arg domain "$TRUST_DOMAIN" --argjson workloads "$WORKLOADS" '
  .nodes[] | . as $n | "spiffe://\($domain)/node/\($n.name)" as $id
  | ([["tpm_devid:subject:cn:\($n.name)"]] + [$n.ek_hashes[] | ["tpm:pub_hash:\(.)"]]
      | map({parent: $server, spiffe: $id, selectors: .}))
    + [$workloads[] | {parent: $id, spiffe: "spiffe://\($domain)/ns/\(.ns)/sa/\(.sa)",
        selectors: ["k8s:ns:\(.ns)", "k8s:sa:\(.sa)"]}]
  | .[] | .selectors |= sort | . + {key: "\(.parent) \(.spiffe) \(.selectors | join(","))"}' "$file" | sort -u)

shown=$(srv entry show -output json)
agents=$(srv agent list -output json)
others=$(jq -r "$defs"' .entries[]? | select(.id | startswith("fleet-") | not) | ekey' <<<"$shown")
existing=$(jq -r '.entries[]? | select(.id | startswith("fleet-")) | .id' <<<"$shown")

# A desired entry that a `git-` entry or one made by hand already issues is skipped, since SPIRE
# rejects the duplicate.
wanted=()
create=()
while read -r line; do
  [ -n "$line" ] || continue
  key=$(jq -r .key <<<"$line")
  grep -qxF "$key" <<<"$others" && continue
  id=fleet-$(printf %s "$key" | sha256sum | cut -c1-16)
  wanted+=("$id")
  grep -qxF "$id" <<<"$existing" || create+=("$(jq -c --arg id "$id" '. + {id: $id}' <<<"$line")")
done <<<"$desired"

# The plan, before anything changes. A node alias that goes names the selector of its agent, and
# the agent goes unless some entry still carries that selector. A withdrawn node is one that holds
# a fleet- alias and that the file no longer lists.
plan=$(jq -n --argjson shown "$shown" --argjson agents "$agents" --slurpfile f "$file" \
  --argjson wanted "$(printf '%s\n' "${wanted[@]}" | jq -R . | jq -sc 'map(select(. != ""))')" \
  --argjson created "$(printf '%s\n' "${create[@]}" | jq -sc .)" \
  --arg server "$server" --arg node "$nodePrefix" "$defs"'
  [$shown.entries[]?] as $entries
  | [$entries[] | select((.id | startswith("fleet-")) and (.id | IN($wanted[]) | not))] as $gone
  | ([$entries[] | select(.id | IN($gone[].id) | not) | sels[]] + [$created[].selectors[]] | unique) as $carried
  | [$entries[] | select((.id | startswith("fleet-")) and (.parent_id | sid) == $server)
      | .spiffe_id | sid | ltrimstr($node)] as $registered
  | [$gone[] | select((.parent_id | sid) == $server) | sels[] | select(IN($carried[]) | not)] as $loose
  | {
      delete: [$gone[].id],
      withdrawn: (($registered | unique) - [$f[0].nodes[].name]),
      evict: [$agents.agents[]? | select(any(sels[]; IN($loose[]))) | .id | sid] | unique
    }')

# At most MAX_WITHDRAWALS nodes leave in one run, so a bulk edit in NetBox cannot withdraw the
# fleet. A run over the cap changes nothing and fails, unless each node over it is named in the
# owner's override file, which the run then removes.
mapfile -t withdrawn < <(jq -r '.withdrawn[]' <<<"$plan")
override=false
if [ "${#withdrawn[@]}" -gt "$MAX_WITHDRAWALS" ]; then
  allowed=""
  [ ! -e "$WITHDRAW_OVERRIDE" ] || allowed=$(<"$WITHDRAW_OVERRIDE")
  excess=()
  for n in "${withdrawn[@]}"; do
    grep -qxF "$n" <<<"$allowed" || excess+=("$n")
  done
  if [ "${#excess[@]}" -gt "$MAX_WITHDRAWALS" ]; then
    echo "refusing to withdraw ${#withdrawn[@]} nodes in one run (${withdrawn[*]}), over the cap of $MAX_WITHDRAWALS; nothing changed. To allow it, name each node in $WITHDRAW_OVERRIDE, one a line." >&2
    exit 1
  fi
  override=true
fi

for line in "${create[@]}"; do
  args=()
  while read -r sel; do args+=(-selector "$sel"); done < <(jq -r '.selectors[]' <<<"$line")
  srv entry create -entryID "$(jq -r .id <<<"$line")" -spiffeID "$(jq -r .spiffe <<<"$line")" \
    -parentID "$(jq -r .parent <<<"$line")" "${args[@]}"
done

for id in $(jq -r '.delete[]' <<<"$plan"); do
  srv entry delete -entryID "$id"
done

for agent in $(jq -r '.evict[]' <<<"$plan"); do
  srv agent evict -spiffeID "$agent"
done

if [ "$override" = true ]; then
  echo "withdrew ${withdrawn[*]} under $WITHDRAW_OVERRIDE, which is now removed"
  rm -f "$WITHDRAW_OVERRIDE"
fi
