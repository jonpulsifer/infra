#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web.
#
# Bootstraps the curated validation toolchain (via mise) so linters, terraform
# validate, and tests work out of the box in a freshly-cloned web container.
# Web-only, synchronous, idempotent — safe to re-run.
set -euo pipefail

# Only run in the remote (Claude Code on the web) environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

export MISE_YES=1

# 1. Install mise if it isn't already on PATH.
if ! command -v mise >/dev/null 2>&1; then
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v mise >/dev/null 2>&1; then
    echo "==> installing mise"
    curl -fsSL https://mise.run | sh
  fi
fi
export PATH="$HOME/.local/bin:$PATH"

# 2. Install the curated set of validation tools. These are pinned unversioned
#    in mise.toml, so 'latest' matches the repo defaults. (go/bun/node already
#    ship in the container; nix and the heavier CLIs are intentionally skipped.)
echo "==> installing curated tools via mise"
mise install \
  opentofu \
  terraform \
  terraform-docs \
  shellcheck \
  shfmt \
  kustomize \
  helm

# 3. Install the 1Password CLI (op) straight from 1Password's CDN.
#    mise's op backends don't work in the scoped web env (the vfox plugin needs
#    an out-of-scope GitHub clone; aqua can't resolve versions for it), so we
#    pull the official zip instead. Skipped if op is already present.
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

# 4. Persist PATH + mise settings into the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    # shellcheck disable=SC2016  # written literally so it expands in the session shell, not here
    echo 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"'
    echo 'export MISE_YES=1'
    # Don't let `mise run <task>` auto-install the full mise.toml toolchain
    # (gcloud, k9s, the out-of-scope 1password vfox plugin, …). Tasks use the
    # curated tools installed above; anything else is installed on demand.
    echo 'export MISE_TASK_RUN_AUTO_INSTALL=0'
  } >>"$CLAUDE_ENV_FILE"
fi

echo "==> session-start hook complete"
