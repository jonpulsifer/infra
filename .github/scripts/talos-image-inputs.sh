#!/usr/bin/env bash
# Prints, as JSON, the Talos version, extensions and baked kernel arguments
# that a clusters/<site>/talos/talos.tf passes to the talos-cluster module.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <talos.tf>" >&2
  exit 64
fi
file=$1

# The quoted strings of `<name> = [ ... ]`, one per line. A `#` or `//`
# outside a string ends the line, since kernel arguments hold `//`.
list() {
  awk -v name="$1" '
    function scan(text,   i, c, s, inq) {
      inq = 0
      s = ""
      for (i = 1; i <= length(text); i++) {
        c = substr(text, i, 1)
        if (inq) {
          if (c == "\\") { i++; s = s substr(text, i, 1); continue }
          if (c == "\"") { print s; s = ""; inq = 0; continue }
          s = s c
        } else if (c == "\"") {
          inq = 1
        } else if (c == "#" || (c == "/" && substr(text, i + 1, 1) == "/")) {
          return 0
        } else if (c == "]") {
          return 1
        }
      }
      return 0
    }
    open { if (scan($0)) open = 0; next }
    $0 ~ "^[[:space:]]*" name "[[:space:]]*=[[:space:]]*\\[" {
      found++
      if (found > 1) { print "duplicate " name > "/dev/stderr"; exit 2 }
      rest = $0
      sub(/^[^[]*\[/, "", rest)
      open = !scan(rest)
    }
  ' "$file"
}

mapfile -t versions < <(sed -nE 's/^[[:space:]]*talos_version[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$file")
if [[ ${#versions[@]} -ne 1 || ! ${versions[0]} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "$file: want one talos_version like v1.14.2, found: ${versions[*]:-none}" >&2
  exit 1
fi

extensions=$(list extensions)
if [[ -z "$extensions" ]]; then
  echo "$file: no extensions list" >&2
  exit 1
fi
while IFS= read -r ext; do
  if [[ ! $ext =~ ^[a-z0-9-]+/[a-z0-9-]+$ ]]; then
    echo "$file: extension '$ext' is not <owner>/<name>" >&2
    exit 1
  fi
done <<<"$extensions"

kernel_args=$(list extra_kernel_args)

jq -n \
  --arg version "${versions[0]}" \
  --arg extensions "$extensions" \
  --arg kernel_args "$kernel_args" \
  '{
    talos_version: $version,
    extensions: ($extensions | split("\n") | map(select(. != ""))),
    extra_kernel_args: ($kernel_args | split("\n") | map(select(. != "")))
  }'
