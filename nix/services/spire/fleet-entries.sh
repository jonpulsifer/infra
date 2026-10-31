#!/usr/bin/env bash
# The fleetd entry applier. spire-server-fleet-entries in nix/services/spire-server.nix runs it as
# root on the SPIRE server's socket. It registers the nodes in $NODES_FILE as `fleet-*` entries,
# withdraws and bans the nodes that leave the file, and bans the agents of the retired nodes the
# file revokes. docs/platform/identity.md has the design.
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

# A file that is not exactly this shape changes nothing. No name or EK hash is both registered and
# revoked.
jq -e '
  def hexes($re): type == "array" and all(.[]; type == "string" and test($re));
  def node($keys): type == "object" and keys == $keys
    and (.name | type == "string" and test("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"))
    and (.ek_hashes | hexes("^[0-9a-f]{64}$"));
  type == "object" and (keys == ["nodes"] or keys == ["nodes", "revoked"])
  and (.nodes | type == "array") and all(.nodes[]; node(["ek_hashes", "name"]))
  and ((has("revoked") | not) or (.revoked | type == "array"))
  and all(.revoked[]?; node(["ek_hashes", "ldevids", "name"]) and (.ldevids | hexes("^[0-9a-f]{40}$")))
  and ([.nodes[].name, .revoked[]?.name] | length == (unique | length))
  and ([.nodes[].ek_hashes[]] - ([.nodes[].ek_hashes[]] - [.revoked[]?.ek_hashes[]]) == [])' "$file" >/dev/null || {
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

# The plan, before anything changes.
#
# A node alias that goes names the selector of its agent, and the agent is banned unless some entry
# still carries that selector, so it cannot attest again with an unexpired LDevID. A withdrawn node
# is one that holds a fleet- alias and is absent from the file.
#
# A revoked node's agents are banned on sight: by the fingerprint of its LDevID, by its EK hash, and
# by its name as an LDevID's CN, which covers every LDevID issued to it.
#
# SPIRE has no unban, so a banned agent of a registered node, which a quarantine lifted or a
# re-provision brings back, is evicted: its record goes, and it attests again. An EK agent's ID is
# its EK hash, so it needs this; a re-provisioned node's new LDevID is a new agent ID.
plan=$(jq -n --argjson shown "$shown" --argjson agents "$agents" --slurpfile f "$file" \
  --argjson wanted "$(printf '%s\n' "${wanted[@]}" | jq -R . | jq -sc 'map(select(. != ""))')" \
  --argjson created "$(printf '%s\n' "${create[@]}" | jq -sc .)" \
  --arg server "$server" --arg node "$nodePrefix" "$defs"'
  [$shown.entries[]?] as $entries
  | [$agents.agents[]? | {id: (.id | sid), path: .id.path, sels: sels, banned: (.banned == true)}] as $agents
  | $f[0].nodes as $nodes
  | [$f[0].revoked[]?] as $revoked
  | [$entries[] | select((.id | startswith("fleet-")) and (.id | IN($wanted[]) | not))] as $gone
  | ([$entries[] | select(.id | IN($gone[].id) | not) | sels[]] + [$created[].selectors[]] | unique) as $carried
  | [$entries[] | select((.id | startswith("fleet-")) and (.parent_id | sid) == $server)
      | .spiffe_id | sid | ltrimstr($node)] as $registered
  | [$gone[] | select((.parent_id | sid) == $server) | sels[] | select(IN($carried[]) | not)] as $loose
  | [$nodes[] | "tpm_devid:subject:cn:\(.name)", "tpm:pub_hash:\(.ek_hashes[])"] as $listed
  | def revokes($a): first($revoked[] as $r | select(
        any($a.sels[]; IN("tpm_devid:subject:cn:\($r.name)", "tpm:pub_hash:\($r.ek_hashes[])"))
        or ($a.path | IN("/spire/agent/tpm_devid/\($r.ldevids[])", "/spire/agent/tpm/\($r.ek_hashes[])")))
      | $r.name);
    [$agents[] | select(.banned | not)
      | (revokes(.) // null) as $r
      | select($r != null or any(.sels[]; IN($loose[])))
      | {id, revoked: $r}] as $ban
  | {
      delete: [$gone[].id],
      withdrawn: (($registered | unique) - [$nodes[].name]),
      ban: [$ban[].id] | unique,
      revoked: [$ban[].revoked | select(. != null)] | unique,
      unban: [$agents[] | select(.banned and any(.sels[]; IN($listed[])) and ((revokes(.) // null) == null)) | .id] | unique
    }')

# At most MAX_WITHDRAWALS nodes are withdrawn or revoked in one run, so a bulk edit in NetBox cannot
# take out the fleet. A run over the cap changes nothing and fails, unless the owner's override file
# names all but MAX_WITHDRAWALS of those nodes; the run then removes the file.
mapfile -t taken < <(jq -r '.withdrawn + .revoked | unique | .[]' <<<"$plan")
override=false
if [ "${#taken[@]}" -gt "$MAX_WITHDRAWALS" ]; then
  allowed=""
  [ ! -e "$WITHDRAW_OVERRIDE" ] || allowed=$(<"$WITHDRAW_OVERRIDE")
  excess=()
  for n in "${taken[@]}"; do
    grep -qxF "$n" <<<"$allowed" || excess+=("$n")
  done
  if [ "${#excess[@]}" -gt "$MAX_WITHDRAWALS" ]; then
    echo "refusing to withdraw or ban ${#taken[@]} nodes in one run (${taken[*]}), over the cap of $MAX_WITHDRAWALS; nothing changed. To allow it, name each node in $WITHDRAW_OVERRIDE, one a line." >&2
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

for agent in $(jq -r '.ban[]' <<<"$plan"); do
  srv agent ban -spiffeID "$agent"
done

for agent in $(jq -r '.unban[]' <<<"$plan"); do
  echo "unbanning $agent: its node is registered again"
  srv agent evict -spiffeID "$agent"
done

if [ "$override" = true ]; then
  echo "withdrew or banned ${taken[*]} under $WITHDRAW_OVERRIDE, which is now removed"
  rm -f "$WITHDRAW_OVERRIDE"
fi
