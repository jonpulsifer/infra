#!/usr/bin/env bash
# Tests pbx-ari-users.awk against `ari show users` text written the way
# Asterisk 22 prints it. AWK picks the interpreter, so CI can run it under
# mawk as well as gawk.

set -euo pipefail

reader="$(cd "$(dirname "$0")" && pwd)/pbx-ari-users.awk"
awk_bin=${AWK:-awk}

# The header and rule, then one "r/o?|name" row per argument.
users() {
  local row
  printf 'r/o?  Username\n----  --------\n'
  for row in "$@"; do printf '%-4s  %s\n' "${row%%|*}" "${row#*|}"; done
}

check() {
  local name=$1 want_status=$2 want_text=$3 text=$4 out status=0
  out=$("$awk_bin" -f "$reader" <<<"$text") || status=$?
  if [[ $status != "$want_status" || $out != *"$want_text"* ]]; then
    printf 'FAIL: %s\nwant exit %s and output containing: %s\ngot exit %s:\n%s\n' \
      "$name" "$want_status" "$want_text" "$status" "$out" >&2
    exit 1
  fi
}

check 'read-only users pass' 0 'switchboard grafana' "$(users 'Yes|switchboard' 'Yes|grafana')"
check 'one user that can write fails' 1 'users that can write: admin' "$(users 'Yes|switchboard' 'No|admin')"
check 'no users fails' 1 'no users' "$(users)"
check 'an ARI config error fails' 1 'not the output' 'Error getting ARI configuration'
check 'empty output fails' 1 'not the output' ''

echo "pbx-ari-users: all tests passed ($awk_bin)"
