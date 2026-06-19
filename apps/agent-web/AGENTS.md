# pi — OpenClaw Agent with Web Terminal UI

## Role
Coding/automation agent with a ghostty-web terminal UI. Full tool stack for agent work with a browser-accessible terminal.

## Stack
- `openclaw` — agent runtime (NO claude, NO opencode)
- `ghostty-web` — WASM terminal served on port 8080
- `mise` — tool version management
- `1password-cli` — secrets
- Full daily-driver tools: git, curl, jq, ripgrep, bat, fd, fzf, yq, rsync, dnsutils, iproute2, lsof, strace, man-db, gh

## Multi-stage Build
1. `ghostty-builder` — zig + bun + ghostty-web compilation
2. `pty-builder` — node-pty native modules
3. `frontend-builder` — HTML/CSS/JS assets
4. `final` — slim runtime with all assets copied in

## Excluded
- NO `claude`, NO `opencode`

## Notes
- Ports: 8080 (web terminal), 18789 (openclaw)
- Runs as uid 1337 (agent)
- /home/agent is a VOLUME
- ghostty-web assets at /opt/ghostty-web/