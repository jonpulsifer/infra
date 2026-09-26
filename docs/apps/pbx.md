---
title: PBX
description: Two Asterisk phone switches, one on folly for the four lines of the office phone and one on offsite, parked, for an ElevenLabs voice agent.
status: live
---

The PBX is Asterisk, an open-source phone switch, on both clusters. On folly, it carries the four lines of the office phone, cathy, a Cisco SPA504G, to voip.ms, the SIP carrier. On offsite, it hands one voip.ms number to an ElevenLabs voice agent, but the pod stays parked at zero replicas today. Git declares the ElevenLabs troll agent, which keeps spam callers talking, and the phone number it answers, and a CronJob on offsite applies them.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| SIP, folly | `PBX_SIP_VIP`, port 5060 | The office phone only, from `CATHY_IP` |
| Provisioning profile, folly | `/cathy.xml` over HTTP at `PBX_SIP_VIP` | The office phone only, from `CATHY_IP` |
| Phone number, offsite | The agent's voip.ms number | Nobody — the pod is parked |

The folly PBX carries each of the four office-phone lines to its own voip.ms sub-account. The offsite PBX opens both of its SIP connections outbound: a registration to voip.ms and calls to ElevenLabs. [Operate the office phone](../runbooks/operate-the-office-phone.md) checks, changes and debugs the office phone.

## Limits

- Every office-phone line, 911 included, depends on folly.
- The offsite PBX stays parked until its trunk proves TLS and the owner asks for that DID to ring.

## How it works

Both sites run the Deployment in `clusters/base/apps/pbx/`, with one replica; offsite's own overlay patches that to zero while it is parked. An init container renders the Asterisk config and fills in the `PBX_*` values from the ConfigMap `pbx-env` and the Secret `pbx-secrets`. External Secrets reads the voip.ms and ElevenLabs credentials from 1Password. Each site's trunks are `config/pjsip.conf` in its own overlay, and its dialplan is the other `config/*.conf` files there; folly's `extensions.conf` includes one file per feature. On folly, an unknown caller on line 4 presses 5 to ring the desk, and a contact from 1Password rings through; [Screen callers on the office phone](../runbooks/screen-callers-on-the-office-phone.md) has the rest.

A change to a config file in git rolls the pod, because each generated ConfigMap name has a content hash. A change to `CATHY_IP` or `PBX_SIP_VIP` in cluster-settings does not. Restart the `pbx` Deployment after it. Reloader restarts the pod when `pbx-secrets` changes.

The folly PBX registers each sub-account over TLS and requires SRTP for media. A sidecar serves the provisioning profile from `provision/cathy.xml`.

Asterisk logs every SIP message. Vector removes the SRTP keys and digest responses before VictoriaLogs stores the logs.

## ElevenLabs agent and number

`clusters/offsite/apps/elevenlabs/desired/` declares the troll agent, `pbx-troll`, and the phone number record it answers. Every 15 minutes, the offsite CronJob `elevenlabs-reconcile` runs `reconcile.sh` to make ElevenLabs match those files. It logs field names, never values.

The write key exists, so the reconciler runs in write mode: it owns `pbx-troll` and the phone number's binding to it in the live ElevenLabs account. Each run creates the agent if none has its name, patches the declared fields that differ, and, once the agent matches git, binds the number with one PATCH that carries the whole inbound trunk and its digest credentials, because the API never returns the password. Without the write key, it only logs what it would create, patch or bind.

- If ElevenLabs reports no credentials after the bind, it unbinds the number and fails the Job.

External Secrets reads three 1Password items in the `homelab` vault, one Secret each: `rowbutt elevenlabs api key` to read, `elevenlabs pbx api key` to write, and `elevenlabs troll trunk` for the digest credentials.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `PBXDown` | Prometheus has had no metrics from the folly PBX for 5 minutes. | [Operate the office phone](../runbooks/operate-the-office-phone.md) |
| `PBXTrunkNotRegistered` | A voip.ms sub-account has not been registered for 5 minutes. | [Operate the office phone](../runbooks/operate-the-office-phone.md) |
| `PBXHandsetOffline` | An office-phone line has not been registered to the PBX for 5 minutes. | [Operate the office phone](../runbooks/operate-the-office-phone.md) |

No alerts watch the offsite PBX. A failed `elevenlabs-reconcile` Job fires `KubeJobFailed`, and its log names the HTTP status or the field at fault.

## Reference

- Manifests: `clusters/base/apps/pbx/`, `clusters/folly/apps/pbx/` and `clusters/offsite/apps/pbx/`
- ElevenLabs reconciler: `clusters/offsite/apps/elevenlabs/`
- Image: `nix/images/asterisk.nix`, built by `.github/workflows/nix-images.yml` and published as `ghcr.io/jonpulsifer/asterisk`
- Alerts: `clusters/folly/monitoring/pbx-rules.yaml`
- Addresses: `CATHY_IP` and `PBX_SIP_VIP` in `clusters/folly/config/cluster-settings.yaml`, a divergence that [Topology](../reference/topology.md#rules) records
