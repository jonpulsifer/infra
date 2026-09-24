#!/usr/bin/env bash
# Checks the docs: the wiki renderer's validation, backticked repo paths, past
# tense in docs/, and references into the wiki from anywhere in the repo.
# Usage: .github/scripts/docs-contract.sh [repo-root]
set -uo pipefail
cd "${1:-$(git rev-parse --show-toplevel)}" || exit 2

status=0
note() { printf '%s\n' "$*"; }
manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT

# --manifest lists every URL the site serves, for the reference check below.
note "==> renderer"
if bun run --cwd apps/wiki check --manifest="$manifest"; then note "    ok"; else status=1; fi

note "==> repo paths"
missing=0
# shellcheck disable=SC2016  # the backticks below are regex literals, not a subshell
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  [[ "$path" == *"<"* || "$path" == *"*"* || "$path" == *'$'* ]] && continue # placeholders
  [[ "$path" == .* ]] && continue                                            # relative fragments
  [[ -e "${path%/}" ]] && continue
  # A token with a space is a path plus arguments when its first word exists.
  first="${path%% *}"
  [[ "$path" == *" "* && -e "${first%/}" ]] && continue
  # Skips CIDRs, image refs, label keys and git refs, which name no root entry.
  [[ -e "${path%%/*}" ]] || continue
  note "    MISSING ${path}"
  missing=1
done < <(grep -rhoE '`[A-Za-z0-9_.-]+/[A-Za-z0-9_./ -]*`' \
  --include='*.md' AGENTS.md README.md docs 2>/dev/null \
  | tr -d '`' | sort -u)
if ((missing)); then status=1; else note "    ok"; fi

# docs/agents/ and the style guide state the rule, so they quote the words it forbids.
note "==> archaeology"
mapfile -t prose < <(find docs -name '*.md' -not -path 'docs/agents/*' -not -path 'docs/reference/style-guide.md' | sort)
if grep -niE '\b(formerly|used to be|previously|no longer|migrated from|kept for continuity|not yet migrated|superseded by)\b' \
  "${prose[@]}" README.md 2>/dev/null; then
  note "    ^ past tense in docs; describe what is true today instead"
  status=1
else
  note "    ok"
fi

# The manifest holds every URL the site serves: pages, heading anchors, assets
# and generated files. /<fn> is a Pages Function in apps/wiki/functions/.
note "==> references into the wiki"

declare -A served=()
while IFS= read -r u; do [[ -n "$u" ]] && served[$u]=1; done <"$manifest"
((${#served[@]})) || {
  note "    the renderer listed no URLs; fix section 1 first"
  status=1
}

url_resolves() {
  local u="${1#*://wiki.lolwtf.ca}" frag="" fn
  if [[ "$u" == *"#"* ]]; then frag="#${u#*#}" u="${u%%#*}"; fi
  u="${u%%\?*}"
  u="/${u#/}"
  fn="${u#/}"
  [[ -z "$frag" && -f "apps/wiki/functions/${fn%/}.ts" ]] && return 0
  # Pages answers /x with /x/.
  [[ "${u##*/}" == *.* || "$u" == */ ]] || u="$u/"
  [[ -n "${served[$u$frag]:-}" ]]
}

# A docs/… path is repo-relative; ../docs/… is relative to the file naming it.
# An anchor must name a heading on the rendered page.
path_resolves() {
  local file="$1" ref="${2%%#*}" frag="" target u
  [[ "$2" == *"#"* ]] && frag="#${2#*#}"
  if [[ "$ref" == .* ]]; then
    target="$(realpath -m --relative-to=. "$(dirname "$file")/$ref")"
  else
    target="$ref"
  fi
  [[ -f "$target" ]] || return 1
  [[ -z "$frag" || "$target" != docs/* || "$target" == docs/agents/* ]] && return 0
  u="${target#docs}"
  u="${u%.md}"
  [[ "$u" == */index ]] && u="${u%index}"
  [[ "$u" == */ ]] || u="$u/"
  [[ -n "${served[$u$frag]:-}" ]]
}

url_re='https?://wiki\.lolwtf\.ca(/[A-Za-z0-9._~/%#-]*)?'
# The leading class keeps apps/x/docs/… out; strip_lead drops that character.
path_re='(^|[^A-Za-z0-9_./-])(\.\.?/)*docs/[A-Za-z0-9_./-]*\.md(#[A-Za-z0-9_-]*)?'
gone_re='(^|[^A-Za-z0-9_./-])(\.\.?/)*docs/(pages|journals|logseq)([^A-Za-z0-9_-]|$)'
# Logseq page links: [[Runbooks/X]], or a bare Architecture/X page name.
logseq_re='\[\[(Home|Architecture|Fleet|Runbooks)(/[^]]*)?\]\]|\b(Architecture|Fleet|Runbooks)/[A-Z][A-Za-z]*( [A-Z][A-Za-z]*)*'
strip_lead() { sed -E 's#^[^.d]##; s#[^A-Za-z0-9_-]$##'; }

# Markdown, skills and alert rules fail on a broken reference; other files warn.
strict=('*.md' '.agents/**' ':(glob)clusters/**/monitoring/*.yaml'
  ':(exclude,glob)**/fixtures/**' ':(exclude,glob)**/testdata/**')
loose=('.' ':(exclude)*.md' ':(exclude).agents/**'
  ':(exclude,glob)clusters/**/monitoring/*.yaml'
  ':(exclude,glob)**/fixtures/**' ':(exclude,glob)**/testdata/**'
  ':(exclude)*_test.*' ':(exclude)*.test.*'
  ':(exclude).github/scripts/docs-contract.sh')

# Prints "file:line<TAB>ref" per unresolved reference. A line already reported
# for its docs/ path is not reported again as a retired directory.
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
  while IFS=: read -r file line ref; do
    printf '%s:%s\t%s (Logseq link; name the page by its docs/… path)\n' "$file" "$line" "$ref"
  done < <(git grep --untracked -nIoE "$logseq_re" -- "$@")
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
