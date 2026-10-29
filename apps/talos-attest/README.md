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
| `ATTEST_CA_CHAIN` | `/etc/talos-attest/devid-ca-chain.pem` | The DevID CA first, then each issuer up to the root |
| `ATTEST_CA_BUNDLE` | none | Every issuing CA of the site, such as `terraform/pki/certs/folly-devid-ca.pem`; a leaf another anchor issued verifies here only when its CA is in it. Each must chain to the root of `ATTEST_CA_CHAIN`. |
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
| `ATTEST_NETBOX_URL` | none | Makes NetBox the system of record: the device with the serial names the machine, its `talos_class` and status; a serial NetBox never saw gets a device at `staged`; each verdict goes to its custom fields; `GET /verdict` reads it first |
| `ATTEST_NETBOX_TOKEN_FILE` | `/run/credentials/talos-attest.service/netbox-token` | The NetBox API token |
| `ATTEST_NETBOX_ROLE` | `kubernetes-node` | The device role a first-sight device gets |

## Device routes

`protocol/protocol.go` holds the JSON types. A refusal is 403 with a verdict
body `{verdict, reason, detail}`; an unknown or expired session is 404.
The verdict is `quarantine` only for a check the machine's TPM signed for:
the boot evidence after credential activation at intake, and after the LAK's
signature on a renewal. It withdraws the LDevID and fails the device in
NetBox. Everything refused before that proof, a wrong MAC, an unknown or
mismatched EK, a failed activation, a quote the LAK did not sign, a
`failed`, `decommissioning` or `offline` device, is the verdict `refused`:
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
| `POST /v1/attest` | Takes the machine's serial, UUID, MAC, hostname and SMBIOS manufacturer, model, SKU and BIOS, its EKs (DER public key and the NV certificate) and a new AK with its creation proof. Finds the machine in NetBox, else in the inventory; a serial NetBox never saw gets its device once activation succeeds. Refuses a `failed`, `decommissioning` or `offline` device. Checks each EK certificate against `roots/`, refuses a ROCA-weak RSA EK, matches the MAC and the EK pins, and answers a session, a 32-byte nonce and one credential challenge per EK. A `planned` device with no pin passes the pin check when every EK has a manufacturer certificate. |
| `POST /v1/attest/{session}/evidence` | Takes each activated secret, a quote over PCRs 0 to 7 qualified by the nonce, the PCR values, the event log, the LDevID key certified by the AK with the nonce, and both keys' blobs. Checks them, replays the log, applies `policy.yaml`, and issues the LDevID and LAK certificates with the subject `CN=<name>, serialNumber=<serial>, OU=<talos_class>, O=<site>`. |
| `POST /v1/attest/{session}/confirm` | Records that the machine stored the certificates and the NV indexes it used |
| `GET /devid/{serial}` | The LDevID of the newest verdict, if it is a pass: `node`, `serial`, `ldevid_cert_pem` (leaf then DevID CA), `lak_cert_pem`, `chain_pem`, `ldevid_pub_blob_b64` (TPMT_PUBLIC), `ldevid_priv_blob_b64` (TPM2B_PRIVATE without its size), `ak_pub_blob_b64`, `ak_priv_blob_b64`, `srk`, `ek_hashes`, `rsa_ek_cert`, `attested_at`, `confirmed`. 404 otherwise. |
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
It is 404 with no LDevID on file and 403 when the device's status forbids it.

## Audit

Every decision is one JSON line on stdout, beside the structured log:
`{event, site, node, serial, class, status, approver, reason, ts}`
with `event` one of `attest.verdict`, `attest.issue` and `attest.renew`.

## Renewal

`tink-attest renew` runs on a running node, in the `tpm-reattest` DaemonSet
of `clusters/folly/apps/spire/`. It reads the LDevID and LAK certificates from
NV, and exits 0 while the LDevID expires in more than `-renew-before`
(default `720h`), or when NV holds neither certificate. NV that holds the LAK
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
holds the in-memory NetBox they use. `renew_sim_test.go` drives
`client.Renew` on the same simulator against a stand-in for the renewal routes
that checks the LAK quote and the certification. `testdata/` holds riptide's and optiplex's
event logs and EK certificates as read from the machines.
