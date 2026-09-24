#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web: installs the validation
# toolchain through mise in a fresh container. Safe to re-run.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

export MISE_YES=1

if ! command -v mise >/dev/null 2>&1; then
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v mise >/dev/null 2>&1; then
    echo "==> installing mise"
    curl -fsSL https://mise.run | sh
  fi
fi
export PATH="$HOME/.local/bin:$PATH"

# The web container ships go, bun and node; nix and the heavier CLIs are skipped.
echo "==> installing curated tools via mise"
mise install \
  opentofu \
  terraform \
  terraform-docs \
  shellcheck \
  shfmt \
  kustomize \
  helm

# mise's op backends fail in the scoped web env: the vfox plugin needs a GitHub
# clone outside the scope, and aqua can't resolve op versions.
if ! command -v op >/dev/null 2>&1; then
  echo "==> installing 1Password CLI (op)"
  case "$(uname -m)" in
    x86_64 | amd64) op_arch=amd64 ;;
    aarch64 | arm64) op_arch=arm64 ;;
    *) op_arch="" ;;
  esac
  if [ -n "$op_arch" ]; then
    op_ver="$(curl -fsS -m 20 'https://app-updates.agilebits.com/check/1/0/CLI2/en/2.0.0/N' \
      | tr ',' '\n' | sed -n 's/.*"version":"\([0-9.]*\)".*/\1/p')"
    if [ -n "$op_ver" ]; then
      op_tmp="$(mktemp -d)"
      if curl -fsSL -m 60 -o "$op_tmp/op.zip" \
        "https://cache.agilebits.com/dist/1P/op2/pkg/v${op_ver}/op_linux_${op_arch}_v${op_ver}.zip" \
        && (cd "$op_tmp" && unzip -oq op.zip op); then
        install -m 0755 "$op_tmp/op" "$HOME/.local/bin/op"
      else
        echo "WARN: 1Password CLI download failed; skipping op" >&2
      fi
      rm -rf "$op_tmp"
    else
      echo "WARN: could not resolve latest op version; skipping op" >&2
    fi
  fi
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    # shellcheck disable=SC2016  # written literally so it expands in the session shell, not here
    echo 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"'
    echo 'export MISE_YES=1'
    # Stops `mise run` from installing the whole mise.toml toolchain.
    echo 'export MISE_TASK_RUN_AUTO_INSTALL=0'
  } >>"$CLAUDE_ENV_FILE"
fi

echo "==> session-start hook complete"
