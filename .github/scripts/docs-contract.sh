#!/usr/bin/env bash
# Docs contract.
#
# The documentation in this repo rotted once because it restated what the tree
# already said and then drifted from it. These checks catch the mechanical half
# of that. The other half — "don't enumerate what the tree enumerates" — is a
# review rule, stated in AGENTS.md, that no script can enforce.
#
#   1. the renderer's own validation passes: frontmatter, nav, relative links,
#      anchors, images (apps/wiki/build.ts --check; needs `bun install`)
#   2. every backticked repo path named in the docs actually exists
#   3. no past-tense archaeology ("formerly", "used to", "migrated from", …)
#   4. every wiki URL and every docs/…md path named outside the site resolves
#      to a page. The wiki serves no redirects, so a renamed page breaks every
#      reference to it. Markdown, skills and alert rules fail the check; any
#      other file only warns, because code comments are not rendered anywhere.
#
# Usage: .github/scripts/docs-contract.sh [repo-root]
set -uo pipefail
cd "${1:-$(git rev-parse --show-toplevel)}" || exit 2

status=0
note() { printf '%s\n' "$*"; }

# ── 1. the renderer validates ────────────────────────────────────────────────
note "==> renderer"
if bun run --cwd apps/wiki check; then note "    ok"; else status=1; fi

# ── 2. referenced repo paths exist ───────────────────────────────────────────
# Only consider a backticked token a repo path when its first segment is a real
# top-level entry. That keeps CIDRs (10.0.0.0/8), image refs
# (ghcr.io/jonpulsifer/hub), label keys (node-role.kubernetes.io/worker), action
# refs (opentofu/setup-opentofu) and git refs (refs/heads/main) out of scope.
# A token with a space is a path followed by arguments when its first word
# exists on its own.
note "==> repo paths"
missing=0
# shellcheck disable=SC2016  # the backticks below are regex literals, not a subshell
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  [[ "$path" == *"<"* || "$path" == *"*"* || "$path" == *'$'* ]] && continue # placeholders
  [[ "$path" == .* ]] && continue                                            # relative fragments
  [[ -e "${path%/}" ]] && continue
  first="${path%% *}"
  [[ "$path" == *" "* && -e "${first%/}" ]] && continue
  # first segment must name something at the repo root
  [[ -e "${path%%/*}" ]] || continue
  note "    MISSING ${path}"
  missing=1
done < <(grep -rhoE '`[A-Za-z0-9_.-]+/[A-Za-z0-9_./ -]*`' \
  --include='*.md' AGENTS.md README.md docs 2>/dev/null \
  | tr -d '`' | sort -u)
if ((missing)); then status=1; else note "    ok"; fi

# ── 3. no archaeology ────────────────────────────────────────────────────────
# AGENTS.md, docs/agents/ and the style guide state the rule, so they quote the
# very words the rule forbids.
note "==> archaeology"
mapfile -t prose < <(find docs -name '*.md' -not -path 'docs/agents/*' \
  -not -path 'docs/reference/style-guide.md' | sort)
if grep -niE '\b(formerly|used to be|previously|no longer|migrated from|kept for continuity|not yet migrated|superseded by)\b' \
  "${prose[@]}" README.md 2>/dev/null; then
  note "    ^ past tense in docs; describe what is true today instead"
  status=1
else
  note "    ok"
fi

# ── 4. references into the wiki resolve ──────────────────────────────────────
# A URL /x/y/ is docs/x/y.md or docs/x/y/index.md. /assets/… is docs/assets/…,
# /<fn> is a Pages Function in apps/wiki/functions/, and the JSON indexes are
# written by apps/wiki/build.ts.
note "==> references into the wiki"

page_exists() { [[ -f "docs/$1.md" || -f "docs/$1/index.md" ]]; }

url_resolves() {
  local p="${1#*://wiki.lolwtf.ca}"
  p="${p%%[#?]*}"
  p="${p#/}"
  p="${p%/}"
  case "$p" in
    "") [[ -f docs/index.md ]] ;;
    assets/*) [[ -f "docs/$p" ]] ;;
    pages.json | search.json) true ;;
    *.*) false ;;
    *) [[ -f "apps/wiki/functions/$p.ts" ]] || page_exists "$p" ;;
  esac
}

# A docs/… path is repo-relative; ../docs/… is relative to the file naming it.
path_resolves() {
  local file="$1" ref="${2%%#*}"
  if [[ "$ref" == .* ]]; then
    [[ -f "$(realpath -m --relative-to=. "$(dirname "$file")/$ref")" ]]
  else
    [[ -f "$ref" ]]
  fi
}

url_re='https?://wiki\.lolwtf\.ca(/[A-Za-z0-9._~/%#-]*)?'
# The leading class keeps apps/x/docs/… out; strip_lead drops that character.
path_re='(^|[^A-Za-z0-9_./-])(\.\.?/)*docs/[A-Za-z0-9_./-]*\.md(#[A-Za-z0-9_-]*)?'
gone_re='(^|[^A-Za-z0-9_./-])(\.\.?/)*docs/(pages|journals|logseq)([^A-Za-z0-9_-]|$)'
strip_lead() { sed -E 's#^[^.d]##; s#[^A-Za-z0-9_-]$##'; }

strict=('*.md' '.agents/**' ':(glob)clusters/**/monitoring/*.yaml'
  ':(exclude,glob)**/fixtures/**' ':(exclude,glob)**/testdata/**')
loose=('.' ':(exclude)*.md' ':(exclude).agents/**'
  ':(exclude,glob)clusters/**/monitoring/*.yaml'
  ':(exclude,glob)**/fixtures/**' ':(exclude,glob)**/testdata/**'
  ':(exclude)*_test.*' ':(exclude)*.test.*'
  ':(exclude).github/scripts/docs-contract.sh')

# Prints "file:line<TAB>ref" for every reference that does not resolve. A line
# whose docs/pages/… path was already reported is not reported again as a
# retired directory.
unresolved() {
  local -A seen=()
  local file line ref key
  while IFS=: read -r file line ref; do
    while [[ "$ref" == *[.,:\;] ]]; do ref="${ref%?}"; done
    url_resolves "$ref" || printf '%s:%s\t%s\n' "$file" "$line" "$ref"
  done < <(git grep --untracked -nIoE "$url_re" -- "$@")
  while IFS=: read -r file line ref; do
    ref="$(strip_lead <<<"$ref")"
    path_resolves "$file" "$ref" && continue
    printf '%s:%s\t%s\n' "$file" "$line" "$ref"
    key="$file:$line"
    seen[$key]=1
  done < <(git grep --untracked -nIoE "$path_re" -- "$@")
  while IFS=: read -r file line ref; do
    key="$file:$line"
    [[ -n "${seen[$key]:-}" ]] && continue
    printf '%s:%s\t%s (retired wiki layout)\n' "$file" "$line" "$(strip_lead <<<"$ref")"
  done < <(git grep --untracked -nIoE "$gone_re" -- "$@")
}

annotate() { # level, file:line, message
  [[ "${GITHUB_ACTIONS:-}" == true ]] || return 0
  printf '::%s file=%s,line=%s::%s\n' "$1" "${2%:*}" "${2##*:}" "$3"
}

broken=0
while IFS=$'\t' read -r loc ref; do
  note "    BROKEN ${loc} -> ${ref}"
  annotate error "$loc" "wiki reference does not resolve: ${ref}"
  broken=1
done < <(unresolved "${strict[@]}" | sort -u)
warned=0
while IFS=$'\t' read -r loc ref; do
  note "    warning ${loc} -> ${ref}"
  annotate warning "$loc" "wiki reference does not resolve: ${ref}"
  warned=1
done < <(unresolved "${loose[@]}" | sort -u)
if ((broken)); then
  note "    ^ point these at the page's current path; the wiki keeps no redirects"
  status=1
elif ((warned)); then
  note "    ok (warnings above are in code; fix them with the code they sit in)"
else
  note "    ok"
fi

if ((status)); then
  note ""
  note "docs contract failed — see AGENTS.md 'Writing rule for these docs'"
fi
exit $status
