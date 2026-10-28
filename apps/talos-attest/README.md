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
ATTEST_CA_CHAIN=../../terraform/pki/certs/folly-devid-ca-chain.pem \
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
| `ATTEST_CA_KEY` | none, required | The DevID CA's private key (PEM: PKCS#8, PKCS#1 or SEC 1). The service refuses to start without it. |
| `ATTEST_CA_CHAIN` | `/etc/talos-attest/devid-ca-chain.pem` | The DevID CA first, then each issuer up to the root |
| `ATTEST_CERT_VALIDITY` | `8760h` | LDevID and LAK lifetime, capped at the CA's |
| `ATTEST_EK_ROOTS` | `/etc/talos-attest/roots` | Directory of pinned TPM manufacturer certificates |
| `ATTEST_POLICY` | `/etc/talos-attest/policy.yaml` | The event-log policy |
| `ATTEST_INVENTORY` | `/etc/talos-attest/machines.yaml` | `clusters/folly/inventory/machines.yaml` |
| `ATTEST_STATE_DIR` | `/var/lib/talos-attest` | Records, issued certificates, key blobs, approvals and `verdicts.jsonl` |
| `ATTEST_APPROVERS` | none, required | Comma-separated tailnet logins for the admin API |
| `ATTEST_PEERS` | none | Comma-separated DevID listeners of the other anchors |
| `ATTEST_METRICS_FILE` | none | A node-exporter textfile the service rewrites on each change |
| `ATTEST_NETBOX_URL` | none | Turns on best-effort NetBox writes |
| `ATTEST_NETBOX_TOKEN_FILE` | `/run/credentials/talos-attest.service/netbox-token` | The NetBox API token |
| `ATTEST_NETBOX_PASS_STATUS` | `active` | The NetBox status of an attested, confirmed machine |

## Device routes

`protocol/protocol.go` holds the JSON types. A refusal is 403 with a verdict
body `{verdict, reason, detail}`; an unknown or expired session is 404.

| Route | Does |
| --- | --- |
| `POST /v1/attest` | Takes the machine's serial, UUID and MAC, its EKs (DER public key and the NV certificate) and a new AK with its creation proof. Checks each EK certificate against `roots/`, refuses a ROCA-weak RSA EK, matches the serial, MAC and EK hashes against the inventory, and answers a session, a 32-byte nonce and one credential challenge per EK. |
| `POST /v1/attest/{session}/evidence` | Takes each activated secret, a quote over PCRs 0 to 7 qualified by the nonce, the PCR values, the event log, the LDevID key certified by the AK with the nonce, and both keys' blobs. Checks them, replays the log, applies `policy.yaml`, and issues the LDevID and LAK certificates. |
| `POST /v1/attest/{session}/confirm` | Records that the machine stored the certificates and the NV indexes it used |
| `GET /devid/{serial}` | The LDevID of the newest verdict, if it is a pass: `node`, `serial`, `ldevid_cert_pem` (leaf then DevID CA), `lak_cert_pem`, `chain_pem`, `ldevid_pub_blob_b64` (TPMT_PUBLIC), `ldevid_priv_blob_b64` (TPM2B_PRIVATE without its size), `ak_pub_blob_b64`, `ak_priv_blob_b64`, `srk`, `ek_hashes`, `rsa_ek_cert`, `attested_at`, `confirmed`. 404 otherwise. |
| `GET /devid/{serial}/{file}` | One of `ldevid.crt`, `lak.crt`, `chain.pem`, `ldevid.pub`, `ldevid.priv`, `ak.pub`, `ak.priv`, raw |
| `GET /verdict/{serial}` | `{status, attested_at, node, uuid, rsa_ek_cert, updated_at}` with status `attested` or `quarantined`; 404 with status `unknown` for no verdict or a pending first intake |
| `GET /healthz`, `GET /metrics` | Health check and Prometheus metrics |

Each anchor keeps the attestations it ran. `?local=1` answers from this
anchor alone; without it, the lookups ask `ATTEST_PEERS` and the newest verdict
wins, so a quarantine on one anchor withdraws a pass on another.

## Admin routes

Every route requires `Tailscale-User-Login` in `ATTEST_APPROVERS`.

| Route | Does |
| --- | --- |
| `GET /machines` | Every record and the inventory's machines |
| `POST /approve` | `{"serial": ...}` approves a pending first intake's EK hashes. Commit them to `machines.yaml` as `ek_hash` and `ek_hash_ecc` afterwards. |

## Test

```bash
go test ./...   # cgo off: unit tests only
CGO_ENABLED=1 go test -race ./...   # with gcc and libssl-dev: the software-TPM end-to-end tests
```

`sim_test.go` runs the real client against the real server on
go-tpm-tools' simulator, with its PCRs replaying `testdata/riptide-eventlog.bin`,
and covers a pass and each refusal. `testdata/` holds riptide's and optiplex's
event logs and EK certificates as read from the machines.
