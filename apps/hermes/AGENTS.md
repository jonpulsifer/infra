# hermes — Brain / Orchestrator Agent

## Role
Pure reasoning, planning, and coordination agent. No CLI tools beyond what's needed to think clearly and delegate.

## Tools (deliberate)
- `openclaw` — runtime
- `mise` — tool version management
- `1password-cli` — secrets
- `git`, `curl`, `jq`, `ripgrep` — core workflow
- `fd`, `bat`, `fzf` — filesystem and search
- `rsync`, `dnsutils`, `iproute2` — network
- `lsof`, `strace` — debugging
- `man-db`, `make` — development

## Excluded
- NO `claude`, NO `opencode`
- NO `ghostty-web` / terminal UI
- NO `nmap`, `tcpdump`, `iperf3` (those belong in a network toolkit container)

## Notes
- Runs as uid 1337 (agent)
- /home/agent is a VOLUME — persist everything there
- Deliberate tool selection: if you can't justify it, it doesn't go in