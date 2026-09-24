---
title: Operate the office phone
description: How the office SPA504G reaches voip.ms through the folly PBX, and how to check it, change it, and debug a call that fails.
---

The office Cisco SPA504G has four lines. Each registers to an Asterisk PBX on
folly, and the PBX carries each line to its own voip.ms sub-account over TLS.
The phone talks only to the PBX and holds no voip.ms credential.

## How it fits together

| Line | voip.ms sub-account | Handset SIP port |
| --- | --- | --- |
| 1 | `168847_cathy` | 5060 |
| 2 | `168847_recorded` | 5060 |
| 3 | `168847_sandbox` | 5060 |
| 4 | `168847_1994` | 5063 |

- **Handset → PBX.** Each line registers as `lineN` to the PBX's LoadBalancer
  address. The PBX identifies a line by that username and admits it only from
  the handset's reserved address, so the lines carry no password. Both
  addresses are `CATHY_IP` and `PBX_SIP_VIP` in
  `clusters/folly/config/cluster-settings.yaml`.
- **PBX → voip.ms.** One registration per sub-account to a numbered server
  over TLS on 5061, with the certificate verified and SRTP mandatory. Every
  call is G.722 end to end. The passwords live in 1Password item
  `voip.ms sub accounts` in the `homelab` vault, one concealed field per
  sub-account, labelled with the username.
- **Everything declared in git.** Asterisk config is under
  `clusters/folly/apps/pbx/config/` and `clusters/base/apps/pbx/config/`; the
  handset's profile is `clusters/folly/apps/pbx/provision/cathy.xml`; the image
  is `nix/images/asterisk.nix`, built by `.github/workflows/nix-images.yml`.

Every line depends on folly being up — dial tone, and **911**. A folly outage
leaves the desk phone with no lines at all; a cell phone is the emergency
backup.

## Check its health

- **Grafana → PBX.** Trunk and line registration, calls, and four log panels:
  call flow, errors, SIP messages, and the handset's profile fetches.
- **Alerts** in `clusters/folly/monitoring/pbx-rules.yaml` go to Discord:
  `PBXDown`, `PBXTrunkNotRegistered` per sub-account, and `PBXHandsetOffline`
  per line.
- **The Asterisk CLI.** Pass `-C`, or the CLI looks for its control socket in
  the wrong directory:

  ```sh
  kubectl --context folly -n pbx exec deploy/pbx -c asterisk -- \
    /bin/asterisk -C /etc/asterisk/asterisk.conf -rx 'pjsip show registrations'
  ```

  `pjsip show contacts`, `pjsip show endpoints` and — during a call —
  `pjsip show channelstats` (per-leg packet counts, loss and jitter) are the
  others worth knowing. The image has no `grep`; filter outside the `exec`.

## Change the phone

Edit `clusters/folly/apps/pbx/provision/cathy.xml` and merge. The profile is
**partial**: the phone changes only the settings the file names and leaves
everything else alone. Never change a setting by hand on the phone — its next
resync puts the file's value back.

The phone resyncs hourly. To apply a change now, have it fetch the profile from
a host that can reach the Management network — the UDM, through
[Inspect the UniFi network](inspect-the-unifi-network.md):

```sh
curl "http://<CATHY_IP>/admin/resync?http://<PBX_SIP_VIP>/cathy.xml"
```

The fetch shows up in the `provision` container's log and on the dashboard.
`http://<CATHY_IP>/admin/spacfg.xml` returns the phone's whole running config.
It includes every setting the phone has, so read it through a filter rather
than printing it.

## Read the SIP

PJSIP logs every SIP message the PBX sends and receives. In VictoriaLogs:

```text
{namespace="pbx", container="asterisk"}
```

Vector removes the SRTP key from every `a=crypto` line and every
`Authorization` header before storing them (`clusters/base/monitoring/vector.yaml`).
The pod's own stdout is not redacted — read `kubectl logs` output through a
filter that drops those lines.

## Diagnose a failed call

| Symptom | Cause |
| --- | --- |
| `Call ... to extension 's' rejected` | voip.ms delivers a sub-account's DID to `s`, not to its digits. `from-voipms` must answer `s`. |
| No inbound INVITE arrives at all | The DID's POP in the voip.ms portal is not the server the trunk registers to. |
| `vms-*: Couldn't negotiate stream ... (nothing)` | The trunk's codecs or SRTP profile do not overlap voip.ms's offer. Read the offer's `m=` and `a=crypto` lines. |
| `lineN: Couldn't negotiate stream ...`, handset shows 488 | The handset offers SRTP on every call (`Secure_Call_Setting` is phone-wide); the line endpoint must accept SDES. |
| Call connects, silent both ways | The RTP port range in `config/rtp.conf` and the ranges the NetworkPolicies open disagree. `rtp show settings` shows what Asterisk uses. |
| `401` → `100 Trying` → bare `503` on one sub-account while another works | voip.ms fraud protection holding a sub-account that started a new calling pattern. Settings look identical; voip.ms support releases it. |
| A line will not register | The source address reaching the PBX is not the handset's: check the VIP's `externalTrafficPolicy: Local` and both policies naming `CATHY_IP`. |

## Techniques that settle it

- **Start captures before the test call.** Hubble's per-node buffer on folly
  covers under a minute. Run `hubble observe --namespace pbx --follow` in the
  node's `cilium-agent`, then place the call.
- **Isolate one variable at a time with a throwaway Asterisk.** A local
  Asterisk with no registration can send the same INVITE with one thing
  changed — transport, account, caller ID — and read voip.ms's verdict. That is
  how the fraud hold above is told apart from a config fault.
- **Prove TLS without credentials.** Qualify-only `OPTIONS` to the server
  exercise the handshake and certificate check and carry no auth. Never trial a
  `REGISTER` with an unproven password: failed authentication can get the
  shared public address blocked, and that address carries every line.
- **Validate what the cluster runs, not what you wrote.** `flux build` piped
  into `kubectl apply --server-side --dry-run=server` catches both Flux's
  variable substitution and schema typing, which `kubectl kustomize` never
  sees. Booting Asterisk against the rendered config catches the rest.
