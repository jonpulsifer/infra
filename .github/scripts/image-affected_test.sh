#!/usr/bin/env bash
# Tests image-affected.sh against a commit graph on disk. bunx is a stub on
# PATH that answers `turbo ls --affected` from a fixture and logs each call.

set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/image-affected.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_CONFIG_GLOBAL="$work/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
: >"$GIT_CONFIG_GLOBAL"

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

export FIXTURES="$work/fixtures"
mkdir -p "$FIXTURES" "$work/bin"
cat >"$work/bin/bunx" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s base=%s head=%s\n' "$*" "${TURBO_SCM_BASE:-}" "${TURBO_SCM_HEAD:-}" >>"$FIXTURES/calls"
[ ! -e "$FIXTURES/turbo-fails" ] || exit 1
cat "$FIXTURES/turbo-out"
STUB
chmod +x "$work/bin/bunx"
export PATH="$work/bin:$PATH"

# Answers as turbo would when `turbo ls --affected` names these packages.
turbo_lists() {
  jq -n '{packageManager: "bun", packages: {count: ($ARGS.positional | length),
    items: [$ARGS.positional[] | {name: ., path: ("apps/" + .)}]}}' --args "$@" \
    >"$FIXTURES/turbo-out"
}

reset() {
  rm -f "$FIXTURES"/*
  turbo_lists
}

repo="$work/repo"
mkdir -p "$repo"
cd "$repo"
git init -q -b main .
git config user.name tester
git config user.email tester@example.invalid

commit() {
  local path="$1" message="$2"
  mkdir -p "$(dirname "$path")"
  echo "$message" >>"$path"
  git add -- "$path"
  git commit -qm "$message"
  git rev-parse HEAD
}

echo '{"devDependencies": {"turbo": "9.8.7"}}' >package.json
git add package.json
git commit -qm root
seed=$(commit apps/ws/main.ts 'ws one')
source_change=$(commit apps/ws/main.ts 'ws two')
lock_change=$(commit bun.lock 'a lockfile bump')
docs_change=$(commit docs/notes.md 'docs only')

watches=(apps/ws package.json bun.lock turbo.json)

# Prints `affected` or `not affected`, and keeps stderr for the warning checks.
ask() {
  local rc=0
  "$script" "$@" 2>"$work/stderr" || rc=$?
  case "$rc" in
    0) echo affected ;;
    1) echo 'not affected' ;;
    *) echo "exit $rc" ;;
  esac
}

calls() { cat "$FIXTURES/calls" 2>/dev/null || true; }

reset
assert_equal 'a change under a watched path is affected' \
  affected "$(ask "$seed" "$source_change" ws "${watches[@]}")"
assert_equal 'a watched path that changed decides without turbo' '' "$(calls)"

reset
assert_equal 'a range that changes no watched path is not affected' \
  'not affected' "$(ask "$lock_change" "$docs_change" ws "${watches[@]}")"
assert_equal 'a range with no root file change asks turbo nothing' '' "$(calls)"

reset
turbo_lists other
assert_equal 'a lockfile change turbo leaves the workspace out of is not affected' \
  'not affected' "$(ask "$source_change" "$lock_change" ws "${watches[@]}")"
assert_equal 'turbo runs at the pinned version over the range it was given' \
  "--bun turbo@9.8.7 ls --affected --output=json base=$source_change head=$lock_change" "$(calls)"

reset
turbo_lists other ws
assert_equal 'a lockfile change turbo names the workspace in is affected' \
  affected "$(ask "$source_change" "$lock_change" ws "${watches[@]}")"

reset
assert_equal 'a lockfile change the entry does not watch is not affected' \
  'not affected' "$(ask "$source_change" "$lock_change" ws apps/ws)"

reset
touch "$FIXTURES/turbo-fails"
assert_equal 'a turbo that fails counts as affected' \
  affected "$(ask "$source_change" "$lock_change" ws "${watches[@]}")"
grep -q '^::warning::' "$work/stderr" || fail 'a turbo failure should warn'

reset
echo 'not json' >"$FIXTURES/turbo-out"
assert_equal 'turbo output with no package list counts as affected' \
  affected "$(ask "$source_change" "$lock_change" ws "${watches[@]}")"
grep -q '^::warning::' "$work/stderr" || fail 'unreadable turbo output should warn'

reset
assert_equal 'a base this checkout does not have counts as affected' \
  affected "$(ask 1234567890abcdef1234567890abcdef12345678 "$lock_change" ws "${watches[@]}")"
grep -q '^::warning::' "$work/stderr" || fail 'a missing base should warn'

reset
assert_equal 'an empty base counts as affected' \
  affected "$(ask '' "$lock_change" ws "${watches[@]}")"

# The working tree is past the head on bun.lock, and turbo would read it.
reset
later_lock=$(commit bun.lock 'another lockfile bump')
assert_equal 'a head whose root files differ from the checkout counts as affected' \
  affected "$(ask "$source_change" "$lock_change" ws "${watches[@]}")"
assert_equal 'the checkout check runs before turbo' '' "$(calls)"
assert_equal 'a head that matches the checkout is asked of turbo' \
  'not affected' "$(ask "$source_change" "$later_lock" ws "${watches[@]}")"

# A depth-1 clone holds both commits after fetching the base, but no history
# joins them, and turbo would then call every package affected.
shallow="$work/shallow"
git clone -q --depth 1 "file://$repo" "$shallow"
git -C "$shallow" fetch -q --depth 1 "file://$repo" "$source_change"
cd "$shallow"
reset
assert_equal 'a checkout too shallow to join base and head counts as affected' \
  affected "$(ask "$source_change" "$later_lock" ws "${watches[@]}")"
grep -q 'merge base' "$work/stderr" || fail "the warning did not name the missing merge base: $(cat "$work/stderr")"
cd "$repo"

reset
assert_equal 'too few arguments is a usage error' 'exit 64' "$(ask "$seed" "$lock_change")"

echo 'image-affected: all assertions passed'
