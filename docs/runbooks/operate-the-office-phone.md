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

A merge under `clusters/folly/apps/pbx/` or `clusters/base/apps/pbx/` rolls the
pod, and Asterisk hangs up every call within 15 seconds of the stop. Merge only
when `core show channels` shows no active call, and not within an hour of a 911
call from the handset: a roll forgets `GLOBAL(LAST911)`, and a callback to a
screened line meets the screen. Line 4 screens unknown callers;
[Screen callers on the office phone](screen-callers-on-the-office-phone.md)
covers the screen, the contacts and the star codes.

## Check its health

- **Grafana → PBX.** Trunk and line registration, calls, and four log panels:
  call flow, errors, SIP messages, and the handset's profile fetches.
- **The Switchboard board** at `https://switchboard.lolwtf.ca`. Each call in
  progress with its IVR stage, each line's handset and trunk registration,
  and the calls that ended since the board started. See
  [Switchboard board](../apps/switchboard/board.md).
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
| `Call ... to extension 's' rejected` | voip.ms delivers a call to a sub-account's registered contact as `s`, not as its digits. `from-voipms` must answer `s`. |
| `No matching endpoint found` on an `INVITE` to the DID's digits with an `X-Dest-User` header | voip.ms sends this sub-account's calls in the DID form, and no identify matches its `X-Dest-User`. voip.ms sets the form, and registrations stay green. Each folly trunk needs its `(trunk-identify)` section; `pjsip show identifies` lists one per trunk. |
| No inbound INVITE arrives at all | The DID's POP in the voip.ms portal is not the server the trunk registers to. |
| `vms-*: Couldn't negotiate stream ... (nothing)` | The trunk's codecs or SRTP profile do not overlap voip.ms's offer. Read the offer's `m=` and `a=crypto` lines. |
| `lineN: Couldn't negotiate stream ...`, handset shows 488 | The handset offers SRTP on every call (`Secure_Call_Setting` is phone-wide); the line endpoint must accept SDES. |
| Call connects, silent both ways | The RTP port range in `config/rtp.conf` and the ingress range for the pod's own RTP ports in `clusters/base/apps/pbx/network-policy.yaml` disagree. `rtp show settings` shows what Asterisk uses. |
| `401` → `100 Trying` → bare `503` on one sub-account while another works | voip.ms fraud protection holding a sub-account that started a new calling pattern. Settings look identical; voip.ms support releases it. |
| A line will not register | The source address reaching the PBX is not the handset's: check the VIP's `externalTrafficPolicy: Local` and both policies naming `CATHY_IP`. |
| A caller on line 4 hears "press five", or is held in a queue | Line 4 screens every caller who is not a contact. See [Screen callers on the office phone](screen-callers-on-the-office-phone.md). |
| `elevenlabs`: no reply to the INVITE, and no TLS error | The PBX cannot reach `sip.rtc.elevenlabs.io` on 5061. Check the egress policy and DNS. |
| `elevenlabs`: `SSL_ERROR_SSL (Handshake)` | The TLS handshake or certificate check failed. Check `ca_list_file` and `verify_server` in `transport-tls` against the server's certificate. |
| `elevenlabs`: `401` twice, then the leg ends | ElevenLabs rejects the credentials: the reconciler on offsite has not re-sent the item, or the pod has not restarted since it changed. Reloader does not watch `pbx-elevenlabs`. |
| `elevenlabs`: `404` | `agent-did` is not the number imported at ElevenLabs, leading `+` included. |
| The agent answers, then silence, and the call ends 30 s later | Its audio never reaches the pod, and `rtp_timeout` ends the leg. |

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
  sees. `mise run pbx:check` boots the image's Asterisk against each site's
  rendered config with no route off the machine. It fails when a PJSIP object
  does not load, when 911 stops reaching a line's trunk, when an inbound call
  can reach a trunk, when a folly trunk stops taking voip.ms's DID-form call,
  when a prompt is missing from `pbx-sounds`, or when the open, contact,
  911-callback, press-5 or spam route changes.
  `.github/workflows/pbx.yml` runs it on every PBX change.
