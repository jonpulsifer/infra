---
title: PBX
description: Two Asterisk phone switches, one on folly for the four lines of the office phone and one on offsite that hands its callers to an ElevenLabs troll agent.
status: live
---

The PBX is Asterisk, an open-source phone switch, on both clusters. On folly, it carries the four lines of the office phone, cathy, a Cisco SPA504G, to voip.ms, the SIP carrier, and hands screened spam callers to the troll agent. On offsite, it takes every call voip.ms delivers to the sub-account `168847_elevenlabs` and hands it to the troll agent. [ElevenLabs](elevenlabs.md) has the troll agent, which keeps spam callers talking, and the phone number it answers.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| SIP, folly | `PBX_SIP_VIP`, port 5060 | The office phone only, from `CATHY_IP` |
| Provisioning profile, folly | `/cathy.xml` over HTTP at `PBX_SIP_VIP` | The office phone only, from `CATHY_IP` |
| [Switchboard board](switchboard/board.md), folly | `https://switchboard.lolwtf.ca` | Clients that route to folly's load-balancer range, with no sign-in |
| Troll line, offsite | Calls voip.ms delivers to the sub-account `168847_elevenlabs` | voip.ms, down the registration the offsite PBX opens |

The folly PBX carries each of the four office-phone lines to its own voip.ms sub-account. The offsite PBX opens both of its SIP connections outbound: a registration to voip.ms and calls to ElevenLabs. [Operate the office phone](../runbooks/operate-the-office-phone.md) checks, changes and debugs the office phone, and [Operate the offsite PBX](../runbooks/operate-the-offsite-pbx.md) checks the offsite PBX.

## Limits

- Every office-phone line, 911 included, depends on folly.
- The offsite PBX sends each call to the troll agent, two at a time and twenty answered a day. It refuses a caller over either cap, or one the agent does not take, before it answers.
- Each PBX counts its own calls to the agent, so the two sites together let through four at once and forty answered a day, twice the limits in `clusters/offsite/apps/elevenlabs/desired/agents/pbx-troll.json`.
- The PBX dashboard, the Switchboard board and the Smiirl read folly alone. The offsite PBX's `pbx-event` lines are in offsite's VictoriaLogs.

## How it works

Both sites run the Deployment in `clusters/base/apps/pbx/`, with one replica. An init container renders the Asterisk config and fills in the `PBX_*` values from the ConfigMap `pbx-env` and the Secret `pbx-secrets` and, on folly, the Secrets `pbx-elevenlabs` and `pbx-ari`. External Secrets reads the voip.ms and ElevenLabs credentials from 1Password. Each site's trunks are `config/pjsip.conf` in its own overlay, and its dialplan is the other `config/*.conf` files there; folly's `extensions.conf` includes one file per feature, and its `config/events.conf` logs one `pbx-event kind=<kind> line=<line> caller=<digits>` line per call event, which the PBX dashboard and the Smiirl count. On folly, an unknown caller on line 4 presses 5 to ring the handset, and a contact from 1Password rings through. A caller who does not press 5 talks to the troll agent, or waits in the Endless Queue or with Robo-Lenny when it does not answer; [Screen callers on the office phone](../runbooks/screen-callers-on-the-office-phone.md) has the rest.

A change to a config file in git rolls the pod, because each generated ConfigMap name has a content hash. A change to `CATHY_IP` or `PBX_SIP_VIP` in cluster-settings does not. Restart the `pbx` Deployment after it. Reloader restarts the pod when `pbx-secrets` changes, live call or not; a change to `pbx-elevenlabs` or `pbx-ari` waits for the next restart.

The folly PBX registers each sub-account over TLS and requires SRTP for media. Each folly trunk in `config/pjsip.conf` matches both forms voip.ms delivers a call in; its comments name them. The offsite trunk, `vms-elevenlabs`, registers the same way and matches both forms too. A sidecar serves the provisioning profile from `provision/cathy.xml`. Asterisk's own HTTP port, which serves `/metrics`, also serves ARI, the Asterisk REST interface, to the user in `config/ari.conf`. The Switchboard board polls it, and the CiliumNetworkPolicy `pbx-ari` admits the board to four paths alone.

On offsite, `config/extensions.conf` sends each call to the troll agent over a TLS trunk like folly's, with `X-Pbx-Mode: troll`, and logs `pbx-event` lines whose `line` is `vms-elevenlabs`. The pod admits no SIP, so 30 s without the agent's audio ends a leg whose BYE never arrives.

Asterisk logs every SIP message. Vector removes the SRTP keys and digest responses before VictoriaLogs stores the logs.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `PBXDown` | Prometheus has had no metrics from a site's PBX for 5 minutes. | [Operate the office phone](../runbooks/operate-the-office-phone.md) |
| `PBXTrunkNotRegistered` | A voip.ms sub-account has not been registered for 5 minutes. | [Operate the office phone](../runbooks/operate-the-office-phone.md) |
| `PBXHandsetOffline` | An office-phone line has not been registered to the PBX for 5 minutes. | [Operate the office phone](../runbooks/operate-the-office-phone.md) |

On offsite, `PBXDown` and `PBXTrunkNotRegistered` are warnings, because that site carries no office line, and [Operate the offsite PBX](../runbooks/operate-the-offsite-pbx.md) covers them. `PBXHandsetOffline` is folly's alone.

## Reference

- Manifests: `clusters/base/apps/pbx/`, `clusters/folly/apps/pbx/` and `clusters/offsite/apps/pbx/`
- Agents and number: [ElevenLabs](elevenlabs.md)
- Image: `nix/images/asterisk.nix`, built by `.github/workflows/nix-images.yml` and published as `ghcr.io/jonpulsifer/asterisk`
- Alerts: `clusters/folly/monitoring/pbx-rules.yaml` and `clusters/offsite/monitoring/pbx-rules.yaml`
- Addresses: `CATHY_IP` and `PBX_SIP_VIP` in `clusters/folly/config/cluster-settings.yaml`, a divergence that [Topology](../reference/topology.md#rules) records
