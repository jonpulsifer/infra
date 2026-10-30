# talos-attest

talos-attest attests a folly machine's TPM and boot chain before the machine
gets a Talos config, and issues it an LDevID and a LAK certificate from the
DevID CA. `cmd/tink-attest` is the client that the Tinkerbell action runs in
HookOS. See [talos-attest](https://wiki.lolwtf.ca/apps/talos-attest/) on the
wiki.

## Run

```bash
go build -o talos-attest .
ATTEST_CA_KEY=/path/to/devid-ca.key \
ATTEST_CA_CHAIN=../../terraform/pki/certs/folly-devid-ca-software-chain.pem \
ATTEST_EK_ROOTS=roots \
ATTEST_POLICY=policy.yaml \
ATTEST_INVENTORY=../../clusters/folly/inventory/machines.yaml \
ATTEST_STATE_DIR=/tmp/talos-attest \
ATTEST_APPROVERS=you@example.com \
./talos-attest
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `ATTEST_ADDR` | `:8080` | Device flow and DevID lookups. `unix:<path>` makes a socket with mode 0660. |
| `ATTEST_DEVID_ADDR` | `:8082` | `GET /devid/` and `GET /verdict/` only, for the cluster's nodes |
| `ATTEST_ADMIN_ADDR` | `:8081` | Admin API behind `tailscale serve`. `unix:<path>` makes a socket with mode 0600. |
| `ATTEST_CA_KEY` | none | The DevID CA's software key (PEM: PKCS#8, PKCS#1 or SEC 1). The service needs it, or `ATTEST_CA_PKCS11_MODULE`. |
| `ATTEST_CA_PKCS11_MODULE` | none | A PKCS#11 module, such as ykcs11. When set, the CA key is on the token, and `ATTEST_CA_KEY` is ignored. Needs a cgo build. |
| `ATTEST_CA_PKCS11_TOKEN` | none | The token label, such as `YubiKey PIV #<serial>` |
| `ATTEST_CA_PKCS11_PIN_FILE` | none | A file that holds the token's user PIN |
| `ATTEST_CA_CERT` | none | A PEM file whose first certificate is the CA's; it picks the key on the token |
| `ATTEST_CA_CHAIN` | `/etc/talos-attest/devid-ca-chain.pem` | The DevID CA first, then each issuer up to the self-signed root |
| `ATTEST_CA_BUNDLE` | none | Every issuing CA of the site, such as `terraform/pki/certs/folly-devid-ca.pem`; a leaf another anchor issued verifies here only when its CA is in it. The last certificate of `ATTEST_CA_CHAIN` is the only root: each CA in the bundle must chain to it, and a bundle that holds a self-signed certificate is refused whole. |
| `ATTEST_SITE` | `folly` | The O of every certificate, and the NetBox site a first-sight device joins |
| `ATTEST_CERT_VALIDITY` | `2160h` | LDevID and LAK lifetime, capped at the CA's. The running node renews from 30 days out. |
| `ATTEST_EK_ROOTS` | `/etc/talos-attest/roots` | Directory of pinned TPM manufacturer certificates |
| `ATTEST_POLICY` | `/etc/talos-attest/policy.yaml` | The event-log policy |
| `ATTEST_INVENTORY` | `/etc/talos-attest/machines.yaml` | `clusters/folly/inventory/machines.yaml`: the machines without NetBox, and a pin, class or MAC NetBox lacks with it |
| `ATTEST_STATE_DIR` | `/var/lib/talos-attest` | Records, issued certificates, key blobs, approvals and `verdicts.jsonl` |
| `ATTEST_APPROVERS` | none, required | Comma-separated tailnet logins for the admin API |
| `ATTEST_PEERS` | none | Comma-separated DevID listeners of the other anchors. A peer gates nothing: only a pass is taken from one, and only after its certificates verify against this CA, its blobs are the keys they certify, and its timestamps are within five minutes of this clock. Passes are ordered by the LDevID's CA-signed issue time, never by the peer's clock, so a replay of an older pass changes nothing and never undoes this anchor's own quarantine. A peer's quarantine is ignored; NetBox carries quarantines. |
| `ATTEST_PEER_SYNC` | `10m` | How often this anchor adopts the newest pass its peers hold for the machines it knows, such as a renewal served elsewhere; `0` turns it off |
| `ATTEST_INTAKE_PER_HOUR` | `10` | How many distinct EKs that activated a credential may create a first-sight device in NetBox per hour |
| `ATTEST_PENDING_MAX` | `50` | How many first-intake claims wait for approval at once; the oldest give way |
| `ATTEST_METRICS_FILE` | none | A node-exporter textfile the service rewrites on each change |
| `ATTEST_NETBOX_URL` | none | Makes NetBox the system of record: the device with the serial names the machine, its `talos_class` and status; a serial NetBox never saw gets a `planned` device once the owner approves it; each verdict goes to its custom fields; `GET /verdict` reads it first |
| `ATTEST_NETBOX_TOKEN_FILE` | `/run/credentials/talos-attest.service/netbox-token` | The NetBox API token |
| `ATTEST_NETBOX_ROLE` | `kubernetes-node` | The device role a first-sight device gets |
| `FLEET_RENDER_URL` | none | fleet-controller's `/render`, such as `http://<SPORE_IP>:8446/render`. When set, an intake pass's confirm answers an install code once the controller has rendered the config under it; unset, no code is minted. |
| `ATTEST_FLEET_SECRET_FILE` | `/run/credentials/talos-attest.service/fleet-secret` | The HMAC key that signs a render request, its surrounding whitespace trimmed. Required when `FLEET_RENDER_URL` is set. |

## Device routes

`protocol/protocol.go` holds the JSON types. A refusal is 403 with a verdict
body `{verdict, reason, detail}`; an unknown or expired session is 404.
The verdict is `quarantine` only for a check the machine's TPM signed for:
the boot evidence after credential activation at intake, and after the LAK's
signature on a renewal. It revokes the identity: NetBox's `attest_verdict`
becomes `quarantined: <reason>`, the status stays, `GET /devid` answers 403,
and fleet-controller cordons the node. Until the owner clears the verdict,
the machine gets no identity and no renewal. Everything refused before that
proof, a wrong MAC, an unknown or mismatched EK, a failed activation, a quote
the LAK did not sign, a quarantined, `failed`, `decommissioning` or `offline`
device, is the verdict `refused`:
counted, audited and journaled, and recorded against no machine, so nobody
withdraws a node's identity by knowing its serial. A first intake's
`pending-approval` is a claim kept apart from the machine records, keyed by
serial, for the owner to approve by name; it writes and replaces no record,
and NetBox is told only when the device has no pass. A serial is 1 to 64
printable ASCII characters, else 400. With NetBox configured and not
answering, every request is 503 `refused`: nothing is created, nothing is
pinned. A device for a serial NetBox never saw is created only after the
machine's TPM activates a credential, and `ATTEST_INTAKE_PER_HOUR` caps the
distinct EKs that may do so, 429 beyond it; a request that never activated
costs nothing.

| Route | Does |
| --- | --- |
| `POST /v1/attest` | Takes the machine's serial, UUID, MAC, hostname and SMBIOS manufacturer, model, SKU and BIOS, its EKs (DER public key and the NV certificate) and a new AK with its creation proof. Finds the machine in NetBox, else in the inventory; a serial NetBox never saw gets its device once activation succeeds. Refuses a quarantined, `failed`, `decommissioning` or `offline` device. Checks each EK certificate against `roots/`, refuses a ROCA-weak RSA EK, matches the MAC and the EK pins, and answers a session, a 32-byte nonce and one credential challenge per EK. A `planned` device with no pin passes the pin check when every EK has a manufacturer certificate. |
| `POST /v1/attest/{session}/evidence` | Takes each activated secret, a quote over PCRs 0 to 7 qualified by the nonce, the PCR values, the event log, the LDevID key certified by the AK with the nonce, both keys' blobs, and optionally `network` (`{address, lldp: {chassis_id, port_id, port_description, system_name}}`) with `network_signature`, the session's AK signing SHA-256 over the nonce, `network` and SHA-256 of the facts' JSON. Checks them, replays the log, applies `policy.yaml`, and issues the LDevID and LAK certificates with the subject `CN=<name>, serialNumber=<serial>, OU=<talos_class>, O=<site>`. Network facts without a good signature are logged and dropped; the pass stands. |
| `POST /v1/attest/{session}/confirm` | Takes the NV indexes the machine used and `signature`, the session's AK signing SHA-256 over the nonce and `confirm` (a TPMT_SIGNATURE, ECDSA). A wrong signature is 403 `refused` and leaves the session open; an unsigned confirm, from an older client, confirms and gets no install code. Evidence posted for a passed session is 404 and leaves it open, and a new start for the machine keeps a pass that waits for its confirm for five minutes. Records the confirm and answers `{status}`, with the install code wrapped to the TPM as [Install code](#install-code) says |
| `GET /devid/{serial}` | The LDevID of the newest verdict, if it is a pass: `node`, `serial`, `ldevid_cert_pem` (leaf then DevID CA), `lak_cert_pem`, `chain_pem`, `ldevid_pub_blob_b64` (TPMT_PUBLIC), `ldevid_priv_blob_b64` (TPM2B_PRIVATE without its size), `ak_pub_blob_b64`, `ak_priv_blob_b64`, `srk`, `ek_hashes`, `rsa_ek_cert`, `attested_at`, `confirmed`. 403 for a quarantined machine, 404 otherwise. |
| `GET /devid/{serial}/{file}` | One of `ldevid.crt`, `lak.crt`, `chain.pem`, `ldevid.pub`, `ldevid.priv`, `ak.pub`, `ak.priv`, raw |
| `GET /verdict/{serial}` | `{status, attested_at, node, uuid, rsa_ek_cert, updated_at, class, site, consumed_at}` with status `attested` or `quarantined`; 404 with status `unknown` for no verdict or a pending first intake. With NetBox, the device's `attest_verdict`, `last_attested`, `talos_class` and `attest_consumed_at` answer, and the anchors' record of the same attestation fills in `uuid` and `rsa_ek_cert`. |
| `GET /healthz`, `GET /metrics` | Health check and Prometheus metrics |

Each anchor keeps the certificates and blobs it issued. `?local=1` answers from
this anchor alone; without it, the lookups ask `ATTEST_PEERS` and the newest
verdict wins, so a quarantine on one anchor withdraws a pass on another. With
NetBox, its verdict gates every answer.

The renewal routes, `POST /v1/renew` and `POST /v1/renew/{session}/evidence`,
are on the DevID listener too. A renewal certifies the LDevID key on file
again with the LAK on file, replays the running boot against the policy's
`renew_required_authorities`, and answers `{ldevid_cert_pem, lak_cert_pem}`.
It is 404 with no LDevID on file and 403 when the device is quarantined or its status forbids it.

The daily check takes the same routes with `"check": true` in the start, and
the start answers `"check": true` only when it opened one. The evidence is
the renewal's, plus `bios`, the SMBIOS BIOS version. Before any write the
LAK on file must sign the quote over the session's nonce and certify the
LDevID key on file with it; a failure there is `refused` and records
nothing. After it, a boot that misses `renew_required_authorities` and the
rest of the policy, or a log that does not replay, is a quarantine, except on
a node whose class is `controlplane`: a check or renewal failure there is 403
`failed-no-quarantine`, written to `attest_verdict` as `failed-no-quarantine:
<reason>`, journaled and exported as `talos_attest_failed_no_quarantine`,
and the status and LDevID stay. A pass
answers `{checked, attested_at}`, issues nothing, and writes only
`attest_verdict` and `last_attested`. Each passing quote from the running
node, check or renewal, records PCR 0 under the BIOS version in the
device's `pcr0_by_bios` JSON field when NetBox defines it: a new version
adds an entry, and a different PCR 0 at a version on file is journaled,
audited as `attest.pcr0` and exported as `talos_attest_pcr0_changed`, and
never written over or quarantined. A verdict matches the LDevID an anchor
serves by `ldevid_serial`, which `GET /verdict` carries, since a check moves
`last_attested`.

## Intake

The owner's stub is the authorization: a `planned` device that NetBox holds
with the claimed serial passes when every EK carries a certificate that
chains to `roots/` (a ROCA-weak RSA EK is refused as always), as any planned
device does. The pass binds the stub to the box.
Before anything is issued the service looks the stub up again, and refuses
when it has left `planned`, when a MAC on file is not the claim's, or
when pins on file are not these EKs. It then puts the claimed MAC on the
stub's first interface, and refuses unless the interface then holds that one
MAC as its primary; the stub keeps its name. Every planned device needs a
claimed MAC that reads as one. Across anchors the first box to bind a stub holds it.
A serial NetBox does not know stays pending until the owner approves it;
its pass then creates a `planned` device, named by the claimed hostname or
`intake-<serial slug>`, with the first-sight facts and the EK hashes as its
pins. The pass leaves a `planned` device planned: fleet-controller sets
`active` when the node fetches its config.

An EK without a pinned maker's certificate leaves the claim pending, and a
claimed MAC that a pass may write must read as six hex bytes. When NetBox
learns the serial between the start and the evidence, the start's rules
decide for that device: it must be `planned`, then its MAC and its pins
decide. A pass never replaces a pin on file; only an empty `ek_hash` or
`ek_hash_ecc` is written. Each stub's binding writes one `attest.intake`
audit line.

### Risks

A declared `planned` box can be impersonated before it attests. The lab's
Secure Boot `.auth` files are public, so anyone with a TPM from a pinned
maker can boot the lab-signed HookOS, rewrite the SMBIOS serial to the
stub's and spoof its MAC on any node port; the first such box to
attest takes the stub's identity. The MAC is a tripwire, not
authentication. Keep the gap between declaring a stub and plugging it in
short; give stubs an `expected_port`; and pin the EK hashes where a vendor supplies them, which
makes the pins, not the stub, decide.

## Install code

With `FLEET_RENDER_URL` set, the signed confirm of an intake pass, never of
a renewal, mints 32 random bytes; the code is their base64url without
padding. The service posts `{serial, uuid, node, class, code}` to the
controller with `X-Fleet-Signature` set to HMAC-SHA512 hex over the body,
and follows no redirect. `uuid` is the session's SMBIOS UUID, lower-cased,
and must read as 8-4-4-4-12 hex, or nothing is rendered. On 201 the answer
carries the code wrapped to the session's TPM, never in the clear:
`install_code_ek_hash`, `install_code_credential` and `install_code_secret`
are TPM2_MakeCredential output for that EK, bound to the session's AK, with
the 32 bytes as the credential. On any other answer, or none, the answer has
no code and one `attest.install` audit line gives the status; the pass
stands either way. The code is never logged.

`tink-attest` recovers the bytes with TPM2_ActivateCredential under the same
AK and writes the code to `-install-code` (`INSTALL_CODE_FILE`, default
`/tmp/fleet/install_code`), mode 0600, for the install action that follows;
a directory it creates gets mode 0700. It logs that it wrote the code,
without the value, and with no code it removes a code an earlier run left.

An intake pass also writes the validated SMBIOS UUID to the device's
`smbios_uuid`, once NetBox defines that field (`scripts/netbox-seed.sh`).
Activating a credential against the EK proves a TPM 2.0, so the pass writes
`tpm_version` `2.0` when the field is empty, which a device declared as a stub
lacks. A value the owner set stays.

## Network facts

`tink-attest` runs in the host's network namespace (the Template's
`namespaces.network: host`). While the TPM works it listens on the boot NIC
for the switch's LLDP frame, for at most 35 seconds, and reads the NIC's
IPv4 address; the session's AK signs both with the evidence. The address
counts only when it is the one the evidence came from: the `X-Real-IP` that
the anchor's nginx sets on the unix socket only it reaches, or the TCP peer
of a request on a TCP listener, whose own `X-Real-IP` is ignored. Another
address is dropped, the port kept, and the device's journal says why. On a
pass whose signature holds, the service writes `attested_address`, `attested_switch`
(the chassis ID), `attested_switch_port` (the port ID) and
`attested_network_at` (the pass's time) to each of those fields NetBox
defines (`scripts/netbox-seed.sh`). A fact the pass lacks clears its field,
and a renewal writes none. fleet-controller cables the machine to the port;
the address is for the owner. The
facts are as true as the HookOS that booted, which the quote proves, and the
switch that sent the frame. The parser in `lldp/` is a copy of the one in
`images/tink-agent-autoid/intake`, whose Docker context cannot reach this
module.

## Audit

Every decision is one JSON line on stdout, beside the structured log:
`{event, site, node, serial, class, status, approver, reason, ts}`
with `event` one of `attest.verdict`, `attest.issue`, `attest.renew`,
`attest.check`, `attest.pcr0`, `attest.install` and `attest.intake`, a
declared stub's binding.

## Renewal

`tink-attest renew` runs on a running node, in the `tpm-reattest` DaemonSet
of `clusters/folly/apps/spire/`. It reads the LDevID and LAK certificates from
NV. While the LDevID expires in more than `-renew-before` (default `720h`)
it runs the daily check, or with `-check=false` exits 0; with neither
certificate in NV it exits 0. It opens the TPM before anything else, and
without one it sends nothing. NV that holds the LAK
and no LDevID, or an index that holds no certificate, counts as due; any
other TPM error fails the run. Otherwise it loads the LAK and
LDevID blobs that `GET /devid/{serial}` serves, and drives the renewal routes
on `ATTEST_URL`, the DevID listener: `POST /v1/renew` with `{serial}`, then
`POST /v1/renew/{session}/evidence` with `{quote, pcrs, event_log, ldevid}`,
a LAK quote over PCRs 0 to 7 and the LDevID key certified by the LAK, both
qualified by the nonce.

Each certificate in the answer must chain to a CA in `-ca-bundle`, certify
the key NV and the blobs name, and carry the machine's name and serial; the
routes are plain HTTP. It writes the LAK certificate to NV first, then the
LDevID, and with `-restart-selector` deletes the pods the selector picks in
`-restart-namespace` on `NODE_NAME`, failing when none matches. `-every`
repeats it, and `-retry` sets the wait after a failed run. `protocol.go` holds
the types.

## Admin routes

Every route requires `Tailscale-User-Login` in `ATTEST_APPROVERS`.

| Route | Does |
| --- | --- |
| `GET /machines` | Every record, the claims that wait for approval with their EK hashes, and the inventory's machines |
| `POST /approve` | `{"serial": ..., "ek_hashes": [...]}` approves the named EK hashes of a pending first intake. The owner names them as `GET /machines` shows them, because a pending record is a claim that another machine may have replaced since; a hash that is not pending is 400. The next pass writes them to NetBox's `ek_hash` and `ek_hash_ecc`; without NetBox, commit them to `machines.yaml`. |

## Test

```bash
go test ./...   # cgo off: unit tests only
CGO_ENABLED=1 go test -race ./...   # with gcc and libssl-dev: the software-TPM end-to-end tests
```

`sim_test.go` runs the real client against the real server on
go-tpm-tools' simulator, with its PCRs replaying `testdata/riptide-eventlog.bin`,
and covers a pass and each refusal. `sim_fleet_test.go` covers a planned
machine, NetBox as the system of record and a renewal, and `netbox_test.go`
holds the in-memory NetBox they use. `sim_intake_test.go` covers the intake
policies. `renew_sim_test.go` drives
`client.Renew` on the same simulator against a stand-in for the renewal routes
that checks the LAK quote and the certification. `testdata/` holds riptide's and optiplex's
event logs and EK certificates as read from the machines.
