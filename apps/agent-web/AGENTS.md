# agent-web — coding agent with a web terminal UI

Publishes `ghcr.io/jonpulsifer/ai-agents`: an agent container with a
browser-accessible terminal.

## Stack

- `openclaw` — the gateway runtime, installed in every variant
- `ghostty-web` — WASM terminal served on port 8080
- `mise` — installed system-wide so it survives the `/home/agent` volume mount
- `1password-cli` — secrets
- Daily-driver tools: git, curl, jq, ripgrep, bat, fd, fzf, yq, rsync, dnsutils,
  iproute2, lsof, strace, man-db, gh

## Variants

One Dockerfile, selected with `--build-arg AGENT_SET`:

| `AGENT_SET` | Contents | Published |
| --- | --- | --- |
| `full` | openclaw plus the coding-agent CLIs: `@anthropic-ai/claude-code`, `opencode-ai`, `@earendil-works/pi-coding-agent` | yes — `ai-agents` |
| `pi` | openclaw only | no; local validation only |

`build.json` builds `AGENT_SET=full`, so the published image includes the
coding-agent CLIs.

## Build stages

1. `ghostty-builder` — zig + bun, compiles ghostty-web
2. `pty-builder` — node-pty native modules
3. `frontend-builder` — HTML/CSS/JS assets from `packages/agent-web-ui`
4. final — slim runtime with the assets copied in

## Runtime

- Ports: 8080 (web terminal), 18789 (openclaw)
- Runs as uid 1337 (`agent`)
- `/home/agent` is a VOLUME — persist everything there
- ghostty-web assets at `/opt/ghostty-web/`
