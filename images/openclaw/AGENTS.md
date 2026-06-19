# openclaw — Minimal Runtime

## Role
OpenClaw runtime host only. No agent brains, no terminal UI. The execution layer.

## Tools (minimal)
- `openclaw` — runtime
- `mise` — tool version management
- `1password-cli` — secrets
- `bun` — package manager
- `ca-certificates`, `curl`, `jq`, `git`, `gnupg` — core utilities
- `dnsutils`, `procps` — network and process inspection

## Excluded
- NO `claude`, NO `opencode`
- NO `ghostty-web` / terminal UI
- NO agent tooling (ripgrep, bat, fzf, strace — those belong in agent containers)

## Notes
- Multi-stage build: builder stage for bun packages, slim final image
- Runs as uid 1337 (agent)
- /home/agent is a VOLUME
- Health check on port 8080
- Entrypoint: `node -e "require('openclaw')"` behind tini