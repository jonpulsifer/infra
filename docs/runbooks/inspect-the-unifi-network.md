---
title: Inspect the UniFi network
description: Read the live state of a UniFi console with the read-only unifi.sh helper, and compare it with terraform/network/unifi/.
---

Use this runbook to read the live networks, devices, clients and BGP of a site before you change `terraform/network/unifi/`. `.agents/skills/unifi-network/unifi.sh` reads a UniFi console, the web app on each site's gateway, through its Network API. The gateway is a UDM Pro at folly and a UCG Max at offsite. The helper reads the folly console by default, and environment variables select the offsite console.

The API commands only read. `ssh` runs any command as `root` on the gateway. Change the network through OpenTofu, as [Apply an OpenTofu change](apply-an-opentofu-change.md) describes.

## Before you start

- Run `mise install`. It installs `op`, the 1Password CLI, and `jq`.
- Set `OP_SERVICE_ACCOUNT_TOKEN` to the token of a 1Password service account that can read the `homelab` vault.
- For `bgp` and `ssh`, you need `sshpass`, or `nix-shell` to fetch it.
- Run the commands from the repository root.

`<udm>` is the first host address in `FUTURE_CIDR` in `clusters/folly/config/lab-topology.json`.

## Read the folly console

1. Make sure that 1Password accepts the token.

   ```bash
   op whoami
   ```

   Result: `User Type: SERVICE_ACCOUNT`.

2. If `unifi.fml.pulsifer.ca` does not resolve, set the console address.

   ```bash
   export UNIFI_HOST=https://<udm> UNIFI_SSH_HOST=<udm>
   ```

3. Read the summary.

   ```bash
   .agents/skills/unifi-network/unifi.sh summary
   ```

   Result: The sections `controller`, `health`, `networks (VLANs)`, `wlans` and `devices`, then the count of active clients.

4. If `health` shows `lan` as `error` or `wlan` as `warning`, list the devices that are not connected.

   ```bash
   .agents/skills/unifi-network/unifi.sh raw /s/default/stat/device | jq -r '.data[] | select(.state != 1) | [.state, .model, .name] | @tsv'
   ```

   Result: The state, model and name of each device that is not connected. State `0` is disconnected.

5. Find a client by name, IP address, MAC address or SSID.

   ```bash
   .agents/skills/unifi-network/unifi.sh find <term>
   ```

   Result: The active clients and the configured clients that match.

6. For the other commands, read the help.

   ```bash
   .agents/skills/unifi-network/unifi.sh help
   ```

   Result: `unifi.sh — read-only UniFi homelab discovery`, then one line for each command.

## Read BGP on the folly gateway

`routes` shows only static routes. The gateway runs BGP in FRR, the routing daemon of the gateway. The helper reads it with `vtysh` over SSH.

> [!CAUTION]
> `bgp` and `ssh` run as `root` on the gateway. Run only commands that read state.

1. Read the BGP summary.

   ```bash
   .agents/skills/unifi-network/unifi.sh bgp
   ```

   Result: `IPv4 Unicast Summary:`, then one line for each peer. The peers are the folly Kubernetes nodes and the offsite gateway.

2. Read the routes that BGP learned.

   ```bash
   .agents/skills/unifi-network/unifi.sh ssh "vtysh -c 'show ip route bgp'"
   ```

   Result: The route table. Each route that BGP learned starts with `B`.

## Read the offsite console

The helper keeps one login session in `${TMPDIR:-/tmp}` for all consoles.

1. Delete the login session.

   ```bash
   rm -f "${TMPDIR:-/tmp}/.unifi-cookies-$(id -u)" "${TMPDIR:-/tmp}/.unifi-csrf-$(id -u)"
   ```

2. Set the 1Password item and the address of the offsite console. `<item>` is the `uuid` of `ephemeral.onepassword_item.unifi` in `terraform/network/unifi/offsite/versions.tf`.

   ```bash
   export OP_UNIFI_ITEM=<item>
   export UNIFI_HOST=$(op item get "$OP_UNIFI_ITEM" --vault homelab --format json | jq -r '.urls[0].href')
   ```

3. Read the summary.

   ```bash
   .agents/skills/unifi-network/unifi.sh summary
   ```

   Result: In the `controller` section, `Device` is `UCGMAX`.

4. When you are done, do step 1 again. Then unset `OP_UNIFI_ITEM` and `UNIFI_HOST`.

## Compare with git

1. Find the declared state in `terraform/network/unifi/folly/` or `terraform/network/unifi/offsite/`.
2. If the live state differs from the declared state, change `terraform/network/unifi/`. Do not change the console by hand.
3. Apply the change, as [Apply an OpenTofu change](apply-an-opentofu-change.md) describes.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `summary` prints `## controller` and stops. | The console name does not resolve. | Do step 2 of [Read the folly console](#read-the-folly-console). |
| `bgp` or `ssh` prints nothing. | The SSH host name does not resolve. | Set `UNIFI_SSH_HOST=<udm>`. |
| The helper prints `error: could not read UniFi username from op`. | `op` has no service account token. | Set `OP_SERVICE_ACCOUNT_TOKEN`. |
| The helper prints `error: login failed (no CSRF token returned)`. | The console refused the login. | Make sure that `UNIFI_HOST` and `OP_UNIFI_ITEM` name the same console. |
| `sysinfo` or `summary` shows `Controller : null`. | The login session belongs to another console. | Do step 1 of [Read the offsite console](#read-the-offsite-console). |
| `integ` prints `error: UNIFI_API_KEY not set`. | `integ` reads the Integration API, which needs an API key. | Set `UNIFI_API_KEY`. |

## Related

- [Network](../platform/network.md): the sites, gateways and networks.
- [Routing and firewall](../platform/network/routing-and-firewall.md): the BGP sessions.
- [Apply an OpenTofu change](apply-an-opentofu-change.md): change the network through Atlantis.
