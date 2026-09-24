---
name: unifi-network
description: >-
  Inspect the live UniFi network without changing it: networks and VLANs,
  WLANs, adopted devices, clients, health and gateway BGP. Use when finding a client or device
  by name, IP or MAC, auditing or debugging the network, or comparing live
  state with terraform/network/unifi/.
metadata:
  runbook: docs/runbooks/inspect-the-unifi-network.md
  wiki: https://wiki.lolwtf.ca/runbooks/inspect-the-unifi-network/
---

# UniFi network

The procedure is `docs/runbooks/inspect-the-unifi-network.md`. The platform
page is `docs/platform/network.md`. The desired state is
`terraform/network/unifi/<site>/`, and Atlantis applies it. These notes cover
what an agent needs beyond them.

## Notes

- The driver is `.agents/skills/unifi-network/unifi.sh`. Run `summary` first;
  `help` lists the other subcommands. The API subcommands are read-only.
- `ssh <cmd>` runs any command as root on the gateway, and `bgp` uses it. Pass
  only commands that read state, such as `vtysh -c 'show …'` or `mca-dump`.
- The driver signs in to the console on the folly gateway (a UDM Pro) as the
  `terraform` user, with credentials from 1Password. `op` needs
  `OP_SERVICE_ACCOUNT_TOKEN`.
  Keep credentials and the commands that reveal them out of chat, logs and
  commits.
- `UNIFI_HOST` and `UNIFI_SSH_HOST` default to `unifi.fml.pulsifer.ca`, which
  resolves only through the folly gateway's DNS. WSL on tallboy, the Windows
  desktop on folly's `future` network, cannot resolve it. There, set both to
  the first host address in `FUTURE_CIDR` in
  `clusters/folly/config/lab-topology.json`. `UNIFI_HOST` takes it as
  `https://<address>`.
- `ssh` and `bgp` print nothing when the SSH host is unreachable, because the
  `nix-shell` path discards errors.
- `integ` reads the Integration API, which needs `UNIFI_API_KEY`. The other
  API subcommands read the legacy Network API, which covers the same data and
  more.
- `health` reports `error` or `warning` for a subsystem that has a
  disconnected or pending device. Check `devices` before you call it an
  outage.
- One session serves every console. It is cached for 50 minutes in
  `${TMPDIR:-/tmp}/.unifi-cookies-<uid>` and `${TMPDIR:-/tmp}/.unifi-csrf-<uid>`.
  Delete both before you switch consoles, after you switch back, and after a
  password rotation.
- For offsite's console, set `OP_UNIFI_ITEM` to the `uuid` of
  `ephemeral.onepassword_item.unifi` in
  `terraform/network/unifi/offsite/versions.tf`. Set `UNIFI_HOST` to that
  item's URL, as the runbook shows.
