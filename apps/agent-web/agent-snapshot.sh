#!/usr/bin/env bash
set -euo pipefail

section() {
  printf '\n== %s ==\n' "$1"
}

tool_version() {
  local name="$1"
  shift || true

  if ! command -v "$name" >/dev/null 2>&1; then
    printf '%-12s missing\n' "$name"
    return 0
  fi

  local output
  output="$({ "$name" "$@" 2>&1 || true; } | sed -n '1p')"
  if [[ -n "$output" ]]; then
    printf '%-12s %s\n' "$name" "$output"
  else
    printf '%-12s available\n' "$name"
  fi
}

section "System"
uname -a
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  printf '%s %s\n' "${NAME:-Linux}" "${VERSION_CODENAME:-${VERSION:-}}"
fi

section "Identity"
id
printf 'shell=%s\nhome=%s\npath=%s\n' "${SHELL:-unknown}" "${HOME:-unknown}" "${PATH:-unknown}"

section "Filesystem"
df -h / /home/agent 2>/dev/null || df -h

section "Network"
ip addr show 2>/dev/null | sed -n '1,80p' || true

section "Tools"
tool_version git --version
tool_version curl --version
tool_version jq --version
tool_version rg --version
tool_version fd --version
tool_version bat --version
tool_version fzf --version
tool_version yq --version
tool_version tree --version
tool_version lsof -v
tool_version strace -V
tool_version gh --version
tool_version mise --version
tool_version bun --version
tool_version node --version
tool_version openclaw --version
tool_version claude --version
tool_version opencode --version

section "Notes"
printf 'Use "agent-snapshot" after landing in a fresh container to confirm what is installed.\n'
