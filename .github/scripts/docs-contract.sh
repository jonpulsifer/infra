#!/usr/bin/env bash
# Docs contract.
#
# The documentation in this repo rotted once because it restated what the tree
# already said and then drifted from it. These checks catch the mechanical half
# of that. The other half — "don't enumerate what the tree enumerates" — is a
# review rule, stated in AGENTS.md, that no script can enforce.
#
#   1. every [[wikilink]] in docs/ resolves to a page that exists
#   2. every backticked repo path named in the docs actually exists
#   3. no past-tense archaeology ("formerly", "used to", "migrated from", …)
#
# Usage: .github/scripts/docs-contract.sh [repo-root]
set -uo pipefail
cd "${1:-$(git rev-parse --show-toplevel)}" || exit 2

status=0
note() { printf '%s\n' "$*"; }

# ── 1. wikilinks resolve ─────────────────────────────────────────────────────
note "==> wikilinks"
broken=0
while IFS= read -r link; do
  [[ -z "$link" ]] && continue
  # A "/" in a Logseq page name is "___" in the filename.
  if [[ ! -f "docs/pages/${link//\//___}.md" ]]; then
    note "    BROKEN [[${link}]] -> no docs/pages/${link//\//___}.md"
    broken=1
  fi
done < <(grep -rhoE '\[\[[^]]+\]\]' docs/pages docs/journals 2>/dev/null \
  | sed 's/^\[\[//; s/\]\]$//' | sort -u)
if ((broken)); then status=1; else note "    ok"; fi

# ── 2. referenced repo paths exist ───────────────────────────────────────────
# Only consider a backticked token a repo path when its first segment is a real
# top-level entry. That keeps CIDRs (10.0.0.0/8), image refs
# (ghcr.io/jonpulsifer/hub), label keys (node-role.kubernetes.io/worker), action
# refs (opentofu/setup-opentofu) and git refs (refs/heads/main) out of scope.
note "==> repo paths"
missing=0
# shellcheck disable=SC2016  # the backticks below are regex literals, not a subshell
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  [[ "$path" == *"<"* || "$path" == *"*"* || "$path" == *'$'* ]] && continue # placeholders
  [[ "$path" == .* ]] && continue                                            # relative fragments
  [[ -e "${path%/}" ]] && continue
  # first segment must name something at the repo root
  [[ -e "${path%%/*}" ]] || continue
  note "    MISSING ${path}"
  missing=1
done < <(grep -rhoE '`[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]*`' \
  AGENTS.md README.md docs/pages docs/agents 2>/dev/null \
  | tr -d '`' | sort -u)
if ((missing)); then status=1; else note "    ok"; fi

# ── 3. no archaeology ────────────────────────────────────────────────────────
# AGENTS.md and docs/agents/domain.md state the rule, so they quote the very
# words the rule forbids. Exclude the rule statements, not the files.
note "==> archaeology"
if grep -rniE '\b(formerly|used to be|previously|no longer|migrated from|kept for continuity|not yet migrated|superseded by)\b' \
  docs/pages README.md 2>/dev/null; then
  note "    ^ past tense in docs; describe what is true today instead"
  status=1
else
  note "    ok"
fi

if ((status)); then
  note ""
  note "docs contract failed — see AGENTS.md 'Writing rule for these docs'"
fi
exit $status
