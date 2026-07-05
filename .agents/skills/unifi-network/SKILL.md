---
name: unifi-network
description: Discover, query, inspect, and reason about the live homelab UniFi network — controller, networks/VLANs, WLANs, adopted devices, and connected clients. Use when asked to look at, audit, debug, or reason about the UniFi network, find a client/device by name/IP/MAC, check what VLANs/subnets/DHCP exist, or reconcile live state against terraform/network/unifi/. Authenticates against the UDM Pro using creds from 1Password (op).
---

# unifi-network

Read-only discovery for the homelab UniFi controller (a **UDM Pro**, Network
app `10.4.57`, at `https://unifi.fml.pulsifer.ca` / `https://10.13.37.1`).
This is the live counterpart to the desired state in `terraform/network/unifi/folly/`
(the primary site; the offsite gateway is `terraform/network/unifi/offsite/`) — use
it to see what the controller *actually* has before editing the Terraform.

The driver is **`.agents/skills/unifi-network/unifi.sh`** (paths below are
relative to the repo root). It pulls the `terraform` Super Admin creds from
the **homelab 1Password vault** via `op`, opens a UniFi-OS cookie session, and
wraps the legacy Network API (`/proxy/network/api/...`) behind named subcommands.
It is **read-only** — every subcommand is a GET. Authoring network state still
goes through `terraform/network/unifi/folly/` + Atlantis (see CLAUDE.md "How Changes Ship").

## Prerequisites

- `op`, `curl`, `jq` — all provided by `mise install` in this repo.
- `OP_SERVICE_ACCOUNT_TOKEN` exported with access to the homelab vault. `op whoami`
  should print `User Type: SERVICE_ACCOUNT`. To set it:
  ```bash
  export OP_SERVICE_ACCOUNT_TOKEN=$(op item get 'Service Account Auth Token: Nixos' --fields=token --account=pulsifer --vault=ib23znjeikv74p37f6mbfk7uya --reveal)
  ```
  In this environment the token was already present in the shell.
- LAN reachability to the controller. From WSL/LAN it resolves directly; from
  off-tailnet you still reach it via `unifi.fml.pulsifer.ca` / `unifi.lolwtf.ca`.

No build step — it's a shell script.

## Run (agent path)

```bash
# from the repo root
chmod +x .agents/skills/unifi-network/unifi.sh   # first time only
D=.agents/skills/unifi-network/unifi.sh

$D summary          # one-shot overview — START HERE
```

`summary` prints controller info, per-subsystem health, networks/VLANs, WLANs,
and adopted devices in one go. Individual subcommands:

```bash
$D networks         # configured networks/VLANs/subnets/DHCP/domains
$D devices          # adopted APs / switches / gateways (model, ip, version, #clients)
$D wlans            # SSIDs + security
$D clients          # live associations, grouped by network, sorted by IP
$D clients-known    # controller-configured clients (fixed IPs, aliases, "Managed by terraform")
$D health           # wan/lan/wlan/www/vpn status
$D sysinfo          # controller version / device type / uptime
$D routes           # static routes (rest/routing) — raw JSON
$D firewall         # firewall rules (rest/firewallrule) — raw JSON
$D portforward      # port-forward rules (rest/portforward) — raw JSON
$D find <term>      # search active + known clients by name/ip/mac/ssid
$D raw <api-path>   # GET any legacy path, e.g.  raw /s/default/stat/health
$D bgp              # FRR/BGP summary over SSH — Cilium k8s peers (see SSH section)
$D ssh <cmd>        # run a command on the UDM as root, e.g.  ssh "mca-dump"
```

Examples that work right now:

```bash
$D find nuc                       # locate a host across active + configured clients
$D raw /s/default/stat/health     # any endpoint not yet wrapped; pipe to jq yourself
```

The cookie session is cached under `$TMPDIR/.unifi-cookies-$UID` for ~50 min, so
repeated calls don't re-login. Override targets with env vars:
`UNIFI_HOST`, `UNIFI_SITE`, `OP_VAULT`, `OP_UNIFI_ITEM`.

### Integration API (developer.ui.com) — optional, needs a key

The driver's `integ` subcommand targets the official Network **Integration API**
(`/proxy/network/integration/v1/...`, the one documented at
`developer.ui.com/network`). That API authenticates with an `X-API-KEY` header
**only** — the cookie session is rejected (`401 api.authentication.missing-credentials`).
No API key exists in the vault today, so this path is dormant:

```bash
$D integ            # -> error: UNIFI_API_KEY not set
```

To enable it: create a key in the UI (Control Plane → Admins → the user →
Create API Key), store it in 1Password, then:

```bash
export UNIFI_API_KEY=$(op item get '<item>' --vault ib23znjeikv74p37f6mbfk7uya --fields credential --reveal)
$D integ /sites
```

Until then, use the **legacy** subcommands above — they cover the same data
(and more: live clients, health) and need no extra key.

## Human path

Browse `https://unifi.fml.pulsifer.ca` in a browser and log in as `terraform`
(password in the `unifi-terraform` vault item). That's the GUI; it's useless from
a headless agent, hence the driver.

## SSH (on-box escape hatch — for things the API can't show)

The UDM Pro accepts SSH as `root` (creds in the `unifi.fml.pulsifer.ca ssh` vault
item). The controller **requires** these flags or auth fails:

```
ssh -o PasswordAuthentication=yes -o ChallengeResponseAuthentication=yes root@unifi.fml.pulsifer.ca
```

It's a password login. `sshpass` isn't preinstalled but is one `nix-shell` away,
so you can drive it non-interactively. This exact command was verified this
session — it prints live BGP state (the Cilium k8s peers that `bgp-folly.conf` /
`bgp-offsite.conf` in this module configure):

```bash
PASS=$(op item get kdtm4q6suztovorkisukvctfme --vault ib23znjeikv74p37f6mbfk7uya --fields password --reveal)
nix-shell -p sshpass --run "SSHPASS='$PASS' sshpass -e \
  ssh -o PasswordAuthentication=yes -o ChallengeResponseAuthentication=yes \
      -o StrictHostKeyChecking=accept-new root@unifi.fml.pulsifer.ca \
  'vtysh -c \"show ip bgp summary\"'"
```

Or interactively, type in the session prompt: `! ssh -o PasswordAuthentication=yes -o ChallengeResponseAuthentication=yes root@unifi.fml.pulsifer.ca`

Genuinely useful on-box (don't reach for these when an API subcommand exists):

- `vtysh -c 'show ip bgp summary'` / `vtysh -c 'show ip route bgp'` — FRR/BGP
  state. The UDM is AS `64512`; k8s nodes peer from AS `64513` (`10.3.0.10-13`).
- `mca-dump` — entire controller state as one JSON blob (`/usr/bin/mca-dump`).
- `ubnt-device-info summary` — model/firmware; `ip -4 addr` — per-VLAN bridge IPs
  (`br0`=Management, `br2`=Lab, `br8`=k8s, `br666`=iot, `br1337`=future).

Prefer the API driver for anything it already covers; SSH is for FRR/BGP, raw
`mca-dump`, and OS-level inspection the Network API doesn't expose.

## Gotchas

- **Two different APIs, two different auths.** Legacy (`/proxy/network/api/...`)
  uses the **cookie + `x-csrf-token`** from `POST /api/auth/login` — this is what
  the driver and the Terraform provider use, and it works. Integration
  (`/proxy/network/integration/v1/...`) uses **`X-API-KEY` only** and ignores the
  cookie. Don't expect one credential to work for both.
- **It's a UDM (UniFi OS), so paths are prefixed `/proxy/network`.** Login is
  `/api/auth/login` (UniFi-OS level), *not* the old `/api/login`. The Network app
  endpoints then live under `/proxy/network/api/s/<site>/...`.
- **`allow_insecure` / `-k` is required** — the controller serves a self-signed
  cert. The driver always passes `curl -k`.
- **`health` reporting `lan: error` / `wlan: warning` is normal-ish** here — it
  flags disconnected/pending/disabled devices, not an outage. Cross-check with
  `devices` (look for `0`-uptime or missing rows) before assuming something's down.
- **`raw` paths must be site-scoped** for most stats: `/s/default/stat/...` or
  `/s/default/rest/...`. Non-site paths like `/self/sites` also work.
- **The `terraform` user is Super Admin** — the session can read everything
  (Protect, Access, etc.), but this driver deliberately only GETs Network data.
  Don't add write verbs here; state changes belong in `terraform/network/unifi/folly/`.

## Troubleshooting

- `error: could not read UniFi username from op (is OP_SERVICE_ACCOUNT_TOKEN set?)`
  → export the service-account token (see Prerequisites); confirm with `op whoami`.
- `login failed (no CSRF token returned)` → controller unreachable or creds
  rotated. Test `curl -sk -o /dev/null -w '%{http_code}\n' https://unifi.fml.pulsifer.ca`
  (expect `200`); verify the `unifi-terraform` item still has a valid password.
- Subcommand prints nothing / empty table → that resource is genuinely empty
  (e.g. `firewallrule` and `portforward` currently return 0 rows). Confirm with
  `$D raw /s/default/rest/firewallrule`.
- `integ` errors with `UNIFI_API_KEY not set` → expected; see "Integration API".
- Stale results after a controller change → delete the cached session:
  `rm -f ${TMPDIR:-/tmp}/.unifi-cookies-$(id -u) ${TMPDIR:-/tmp}/.unifi-csrf-$(id -u)`.
