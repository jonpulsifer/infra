# fleetd

fleetd attests a folly machine's TPM and boot chain, issues it an LDevID and a LAK certificate
from the DevID CA, turns NetBox's `kubernetes-node` devices into Tinkerbell objects, and renders
and serves the Talos config each install fetches. `attest/` is the verifier, `fleet/` the
reconciler and installer, and `main.go` wires them into one process. `cmd/tink-attest` is the
client HookOS and the `tpm-reattest` DaemonSet run. See [fleetd](https://wiki.lolwtf.ca/apps/fleetd/)
on the wiki.

## Run

```sh
go build -o fleetd .
ATTEST_CA_KEY=/path/to/devid-ca.key ATTEST_CA_CHAIN=chain.pem ATTEST_EK_ROOTS=attest/roots \
ATTEST_POLICY=attest/policy FLEET_CLASSES=../../clusters/folly/fleet/classes.json \
ATTEST_STATE_DIR=/tmp/fleetd ATTEST_APPROVERS=you@example.com \
FLEET_NETBOX_URL=http://capsule:8080 FLEET_NETBOX_TOKEN_FILE=token \
FLEET_HOOKOS_URL=http://10.9.0.11/talos/folly/hookos-amd64-secureboot-uki.efi FLEET_HOOKOS_CMDLINE='console=tty0' \
./fleetd
```

### Listeners

| Variable | Default | Serves |
| --- | --- | --- |
| `FLEETD_BOOT_ADDR` | `:8443` | The device flow under `/attest/` and `GET /talos/config`, with TLS when `FLEETD_TLS_CERT` and `FLEETD_TLS_KEY` name the enrollment name's certificate and key, which fleetd reads again when the certificate file changes. Until the certificate reads and the address binds, fleetd tries again every 10 seconds; the other listeners bind on their own |
| `ATTEST_DEVID_ADDR` | `:8444` | `GET /devid/`, `GET /verdict/` and the renewal routes, for the cluster's nodes |
| `ATTEST_ADMIN_ADDR` | `:8445` | The admin API. `unix:<path>` makes a socket with mode 0600 |
| `FLEET_WEBHOOK_ADDR` | `:8446` | `POST /webhook`, `GET /healthz` and `GET /metrics` |

### Attestation

| Variable | Default | Meaning |
| --- | --- | --- |
| `ATTEST_CA_KEY` | none | The DevID CA's software key (PEM). Needed unless `ATTEST_CA_PKCS11_MODULE` is set |
| `ATTEST_CA_PKCS11_MODULE`, `ATTEST_CA_PKCS11_TOKEN`, `ATTEST_CA_PKCS11_PIN_FILE`, `ATTEST_CA_CERT` | none | A PKCS#11 module such as ykcs11, the token label, a PIN file and a PEM whose first certificate picks the key on the token. Needs a cgo build |
| `ATTEST_CA_CHAIN` | `/etc/fleetd/devid-ca-chain.pem` | The DevID CA first, then each issuer up to the self-signed root |
| `ATTEST_CA_BUNDLE` | none | Every issuing CA of the site. A leaf another CA issued verifies only when its CA is here, and each must chain to the chain's root |
| `ATTEST_SITE` | `folly` | The O of every certificate, and the site each audit line names |
| `ATTEST_CERT_VALIDITY` | `2160h` | LDevID and LAK lifetime, capped at the CA's |
| `ATTEST_EK_ROOTS`, `ATTEST_POLICY` | `/etc/fleetd/…` | Pinned TPM manufacturer certificates and the directory of event-log policy profiles, one `<name>.yaml` each |
| `ATTEST_STATE_DIR` | `/var/lib/fleetd/attest` | Records, issued certificates, key blobs, waiting claims and `verdicts.jsonl` |
| `ATTEST_APPROVERS` | none, required | Comma-separated tailnet logins for the admin API |
| `ATTEST_NETBOX_URL`, `ATTEST_NETBOX_TOKEN_FILE` | required, `/run/credentials/fleetd.service/netbox-token` | NetBox, the only source of machines and of each one's approved EK binding. A serial it lacks waits for its node entry, and a NetBox that does not answer refuses every request |
| `ATTEST_PENDING_MAX` | `50` | How many claims wait at once for an approved EK binding |
| `ATTEST_BINDING_AUTHOR` | none | The NetBox user Terraform writes as. A binding counts only when NetBox's changelog shows this user made its newest change; unset, no binding counts |
| `ATTEST_METRICS_FILE` | none | A node-exporter textfile rewritten on each change |

### Fleet

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEET_SITE`, `FLEET_NAMESPACE` | `folly`, `tinkerbell` | The NetBox site and Tinkerbell's namespace |
| `FLEET_CLASSES` | required, `/etc/fleetd/classes.json` for the verifier | The class table: each class's Template, installer image, policy profile and payload kind |
| `FLEET_NETBOX_URL`, `FLEET_NETBOX_TOKEN_FILE` | required | NetBox and a token that changes devices and adds journal entries |
| `FLEET_KUBE_SERVER`, `FLEET_KUBE_CA_FILE`, `FLEET_KUBE_CERT_FILE`, `FLEET_KUBE_KEY_FILE` | `https://localhost:6443`, `/etc/tinkerbell/…` | Tinkerbell's API and a client certificate that manages `hardware`, `machines` and `workflows` |
| `FLEET_CLUSTER_SERVER`, `FLEET_CLUSTER_CA_FILE`, `FLEET_CLUSTER_TOKEN_FILE` | none | The site cluster's API, its CA and the cordon account's token; all three or none |
| `FLEET_HOOKOS_URL`, `FLEET_HOOKOS_CMDLINE` | required | The signed HookOS UKI and the command line each Hardware's iPXE script passes |
| `FLEET_BMC_SECRETS` | `amt=bmc-amt` | The Secret per `bmc_type` a Machine names |
| `FLEET_WEBHOOK_SECRET_FILE` | none | NetBox's event-rule secret; without it `/webhook` answers 503 and fleetd only polls |
| `FLEET_SPIRE_NODES_FILE` | none | The file each pass writes with the nodes SPIRE registers: `{"nodes": [{"name", "ek_hashes"}]}` for each `active` device with a passing verdict. Not written while NetBox lists no device |
| `FLEET_INTERVAL`, `FLEET_WORKFLOW_TTL` | `2m`, `168h` | Time between passes, and the age at which fleetd deletes its Workflows |
| `FLEET_CLASS_INPUTS`, `FLEET_WORKER_SECRETS`, `FLEET_TALOSCTL` | none | The class inputs, the worker subset of the secrets bundle and talosctl; all three or none. Without them nothing renders |
| `FLEET_INSTALLS` | `false` | Whether a rendered class's provision installs |
| `FLEET_CONFIG_TTL`, `FLEET_CONTROLPLANE_CONFIG_TTL` | `2h`, `30m` | How long an unread config waits, and a control plane's |
| `FLEET_CONFIG_DIR` | none | A tmpfs directory, mode 0700, that keeps each config's record, bytes and burn state across a restart; without it configs live in memory alone |
| `FLEET_CONTROLPLANE_BUNDLE`, `FLEET_BOOTSTRAP_ADDRESS` | none | The full secrets bundle, which lets a joining control plane render, and the address of the control plane the Talos root bootstraps, which never installs from here |
| `FLEET_AUTO_PROVISION` | `false` | Whether an admitted worker that never ran a Workflow starts its provision |
| `FLEET_TFTP_DIR`, `FLEET_TFTP_LINK_TARGET` | none | The TFTP root and the file each `<mac>/netboot-not-allowed` link points at. Each pass makes the link for every MAC NetBox holds and removes a MAC directory that holds only a stale link; without them fleetd makes none |

## Device flow

`protocol/protocol.go` holds the JSON types. A refusal is 403 with a verdict body
`{verdict, reason, detail}`; an unknown or expired session is 404. The verdict is `quarantine` only
for a check the machine's TPM signed for: the boot evidence after credential activation at intake,
and after the LAK's signature on a renewal. Everything refused before that proof, a wrong MAC, an
unknown or mismatched EK, a failed activation, a quote the LAK did not sign, a quarantined, `failed`,
`decommissioning` or `offline` device, is `refused`: counted, audited and journaled, and recorded
against no machine. An intake that fails after the TPM's proof while no run expects the machine in
HookOS, a device that is not `planned` with no unfinished Workflow, is `refused` with the reason
`unattended-boot`: it records nothing and journals the device. A serial is 1 to 64 printable ASCII characters, else 400. With NetBox configured
and not answering, every request is 503 `refused`.

| Route | Does |
| --- | --- |
| `POST /v1/attest` | Takes the machine's serial, UUID, MAC, hostname, SMBIOS facts, EKs and a new AK. Finds the device by serial, checks each EK certificate against the roots, refuses a ROCA-weak RSA EK, matches the MAC and the approved EK binding, and answers a session, a nonce and one credential challenge per EK. A `planned` device with no binding waits; [Approved EK binding](#approved-ek-binding) has the rules |
| `POST /v1/attest/{session}/evidence` | Takes the activated secrets, a quote over PCRs 0 to 7, the event log, the LDevID key certified by the AK, both keys' blobs, and optionally `network` signed by the AK. Replays the log against the policy profile of the device's class and issues the LDevID and LAK with `CN=<name>, serialNumber=<serial>, OU=<talos_class>, O=<site>`. Unsigned network facts are dropped and the pass stands |
| `POST /v1/attest/{session}/confirm` | Takes the NV indexes and the AK's signature over the nonce. A wrong signature is refused and leaves the session open. An intake pass's signed confirm answers the install code |
| `GET /devid/{serial}`, `GET /devid/{serial}/{file}` | The LDevID of the newest pass with its blobs, or one file raw. 403 for a quarantined machine |
| `GET /verdict/{serial}` | `{status, attested_at, node, uuid, rsa_ek_cert, updated_at, class, site, consumed_at, ldevid_serial}`, NetBox's when it answers |
| `POST /v1/renew`, `POST /v1/renew/{session}/evidence` | The renewal, and with `"check": true` the daily check, from the running node |

## Approved EK binding

The nodes file approves a node's EKs as `approved_ek_rsa2048` and `approved_ek_eccp256`, each the
`EKHash` of the key: lowercase hex SHA-256 of its DER SubjectPublicKeyInfo. `terraform/netbox/folly`
projects them into the device's `approved_ek_hash` and `approved_ek_hash_ecc`, which fleetd reads
and never writes. The EKs a pass proves go to `ek_hash` and `ek_hash_ecc`, which only fleetd writes.

- A `planned` device passes only when every approved EK is sent, matches its hash exactly and
  activates its credential, and the quote and the boot policy pass. Another EK passes the usual
  checks and authorizes nothing. A manufacturer certificate admits no device on its own.
- A `planned` device without a binding, and a serial NetBox lacks, wait as a claim in
  `pending/`, which authorizes nothing and creates no device.
- EKs that are not the binding are refused at the start. fleetd writes nothing, quarantines nothing
  and journals the device at most every ten minutes.
- A binding counts only when `ATTEST_BINDING_AUTHOR` made its newest change. fleetd reads the
  device's records in `/api/core/object-changes/`, newest first, and takes the first one whose
  `prechange_data` and `postchange_data` differ in either field. A binding another user wrote, a
  changelog that does not answer, and one with no record that sets the current value are refused
  with `ek-binding-unauthored` and journaled; nothing is recorded or quarantined. The token needs
  the view permission on core object changes.
- Right before it issues the LDevID, and again before it answers the install code, fleetd reads the
  device and its changelog again, and refuses when the binding changed, went, or was last written
  by someone else since the start. No claim changes the binding: fleetd never writes it.
- A pass that matched the binding pins the binding alone: each approved hash, and null for an
  algorithm the binding leaves out, journaled, so neither a removed TPM's EK nor an extra EK the
  pass sent stays a pin. Without a binding only an empty pin is written. A replaced TPM needs a
  change to the binding in the nodes file.
- A renewal and the daily check prove the LAK on file and read no EK. A `planned` device gets no
  renewal, since its identity comes from an intake pass; it is refused and journaled. A HookOS
  attestation of a device past `planned` without a binding is held to its `ek_hash` pins, and gets
  no install code.

A planned stub binds to the first box that passes for its serial: fleetd puts the claimed MAC on
the stub's interface. `mise run attest:approve <serial>` prints the nodes-file lines for a waiting
claim's hashes, for the owner to compare with a receiving scan or the supplier's record before a
pull request adds them; it authorizes nothing.

## Install code and admission

The signed confirm of an intake pass, never of a renewal, mints 32 random bytes as base64url and
calls the fleet's `Admit` in process with `{serial, uuid, node, class, code}`. `uuid` is the
session's SMBIOS UUID lower-cased, and must read as 8-4-4-4-12 hex. `Admit`:

1. Refuses a device that is not `planned`, that lacks a declared field (`talos_class`, `install_disk`,
   `install_disk_serial`, `bmc_type`, `tpm_version`, `amt`, `secure_boot_expected`, `expected_port`
   or `primary_ip4`), or whose attested LLDP port, from the last hour, is not its `expected_port`;
   nothing is written and the journal says why. `terraform/netbox/folly` declares every one of them
   from the nodes file, and fleetd fills in none.
2. Starts the provision Workflow, with no boot mode, unless one is running: when `desired_action` is
   `provision`, or when the device never ran a Workflow, auto-provision is on, and it is a worker.
3. Renders the config. The render refuses a device whose `last_workflow` is not an unfinished
   `provision` with `install=true`, a spent code, another `smbios_uuid`, a device without
   `tpm_version`, and a control plane without the bundle, at the bootstrap address or with no
   address.

Only when the render succeeds does the confirm carry the code, wrapped to the session's TPM with
TPM2_MakeCredential; otherwise one `attest.install` audit line says why and the pass stands. The
code is never logged. `tink-attest` unwraps it and writes it to `-install-code`, mode 0600. A new
run starts only after the render's device gates pass (`Installer.Ready`), and the Template wipes a
provision's disk only after the boot's pass and with the code. `Admit` waits for a reconcile pass
and gives up when its context ends.

## Config

`GET /talos/config?uuid=<uuid>&code=<code>` answers the config whole with `Cache-Control: no-store`.
The first response whose bytes are all written burns it; after the answer, fleetd sets the device
`active` and writes `attest_consumed_at`, and a release NetBox refuses is retried each pass and
journaled once. One fetch claims a config at a time. HEAD and
other methods are 405, `If-None-Match` and `If-Modified-Since` are 400, and a Range is ignored. A
machine has one config at a time: a new render burns the old code. A spent code stays refused for
a day. A fetch with another code is journaled at most every ten minutes per machine. Each reconcile
pass drops, burns and journals the unread config of a device that is no longer `planned`, such as
one set `decommissioning`. With `FLEET_CONFIG_DIR`, configs survive a restart with their TTL and
burn state.

## NetBox contract

Devices with role `kubernetes-node` and status `planned`, `active`, `failed` or `decommissioning`.
fleetd reads the name, serial, status, `primary_ip4`, `oob_ip`, the first physical interface's
`primary_mac_address`, and the custom fields `install_disk`, `install_disk_serial`, `talos_class`,
`tpm_version`, `bmc_type`, `amt`, `secure_boot_expected`, `desired_action`, `last_workflow`,
`expected_port`, `smbios_uuid`, `attest_verdict`, `approved_ek_hash`, `approved_ek_hash_ecc` and the attested network fields. It writes the verdict fields, the
observed EK hashes, the SMBIOS facts, `pcr0_by_bios`, `desired_action` back to `none`,
`last_workflow`, `status` and journal entries. A `quarantined` verdict cordons the node through the
cluster's API on every pass; a control plane's `failed-no-quarantine` is no quarantine, and fleetd
never uncordons.

A `provision`, `wipe` or `retire` run starts only for a device whose `install_disk_serial` is set
and well formed; otherwise the journal says the run waits and `desired_action` stays. Each
Workflow's `hardwareMap` carries the serial as `install_disk_serial`, because Tinkerbell's Hardware
CRD keeps only a disk's `device`. The Template refuses to wipe or install unless the disk at
`install_disk` reports that serial, no other disk reports it, and it is neither removable nor on
USB.

## One run per machine

Tinkerbell's server hands an agent an action from any of its machine's Workflows, chosen afresh on
each request, so two Workflows for one machine interleave and either can wipe what the other
installed. fleetd keeps at most one unfinished Workflow per device. Each pass and each `Admit`
take one lock, and every request reads the device's Workflows from the API server. A request
that finds a run going never creates another:

| Request while run X goes | Outcome | Journal |
| --- | --- | --- |
| X's own action | Consumed: `desired_action` goes to `none` and `last_workflow` names X | `Workflow X (<action>) is already running; the request is that run` |
| Another action | Left set, and NetBox is not written; the first pass after X ends starts it | Once: `<action> waits: Workflow X (<its action>) is still running; it starts when X ends` |
| An intake's provision from `Admit` | No run and no code; the confirm is refused | Only the owner's `desired_action: provision` waits, as above |
| `decommissioning` | See below | |

The Workflow is the record of the request that started it. fleetd creates the run, then writes
`desired_action: none` and `last_workflow` in one NetBox PATCH. When that write fails, the request
stays set, and every later pass finds a newest Workflow with the action's `lolwtf.ca/action` label
that `last_workflow` does not name. It adopts that run, unfinished or ended, creates and deletes
nothing, and writes again until NetBox takes it, with the journal `started Workflow X (<action>);
its record was late, and it is <state>`. The pass reports the failed write each time. Only a run
still going moves the device's status. The rule holds across a restart, since the record is in
the API server.

A device set `decommissioning` while a run of another action goes gets its retirement at once
when it has a BMC. In one pass fleetd reads the run again, deletes it with that read's
`resourceVersion`, creates the retire Workflow with `bootMode: netboot`, and journals `the retirement ends Workflow X
(<action>) and starts Y; a power cycle stops X`. Rufio's power cycle stops the run's current
action before the retirement's first. A run that changed between the read and the delete answers
409 and stays; the journal says so once, and the next pass tries again. A device without a BMC keeps the run: a deleted run's current action
goes on, writes the disk and leaves the agent stuck reporting it. The journal says once that the
retirement waits for X and that powering the machine off ends it, and the retirement starts on
the pass after X ends.

A device the owner moves out of `decommissioning` has its unfinished retirement deleted the same
way, with a BMC and a fresh read's `resourceVersion`, and journaled; an action already running on the
machine runs to its end, and the next run's power cycle stops it. Without a BMC the retirement is
kept and journaled, and once it passes its global timeout it ends as any run does.

A node retired mid-install never fetches its config: [Config](#config) drops it.

## Overdue Workflows

Tinkerbell's controller checks a Workflow's global timeout only when it reconciles that Workflow,
and a silent agent writes nothing. fleetd writes the annotation `lolwtf.ca/overdue-at` once to
every unfinished Workflow whose `status.globalExecutionStop` is more than `FLEET_INTERVAL` in the
past, and the write makes the controller set `TIMEOUT`. The write is a merge patch on
`metadata.annotations` alone, so `spec` and `status` stay with their owners. The journal says once
per Workflow which action was current; for `reboot` it says the install and next-boot reported
success and the reboot's report was lost.

The controller sets `globalExecutionStop` only once the first action, wipe-disk, reports a start
time, and tink-agent sends one only with the action's result. A run cut off before that report, by a
power loss, a machine that never reaches HookOS or an agent that dies, has no deadline, and the next
netboot resumes it and wipes the disk. fleetd deletes an unfinished Workflow with no deadline, or
one that does not parse, once its `creationTimestamp` plus `status.globalTimeout` is more than
`FLEET_INTERVAL` in the past; without `status.globalTimeout` it takes the Template's 1,800 seconds.
The delete carries the `resourceVersion` the pass read, so a first report that lands in between
keeps the run. A deleted Workflow leaves netboot off, `Admit` renders no code for it, and the next
`desired_action` starts a new run. A run fleetd boots by hand, on a device without a BMC, must reach
wipe-disk within that window. One `fleet.workflow` audit line says `ended`, and the journal says
once that the run never reported its first action, that the disk may be partly wiped or may hold the
old install, and that `desired_action` runs it again. The retirement of a decommissioning device is
left alone: decommissioning asks for it again at once, and moving the device out of
decommissioning abandons it.

## Audit

Every decision is one JSON line on stdout: `attest.verdict`, `attest.issue`, `attest.renew`,
`attest.check`, `attest.pcr0`, `attest.install`, `attest.intake`, `fleet.workflow`, `fleet.bind`,
`fleet.autoprovision`, `fleet.render`, `fleet.release`, `fleet.expire`, `fleet.retire` and
`fleet.cordon`.

## Test

```sh
go test ./...                                                 # cgo off: no software TPM
nix-shell -p gcc openssl --run 'CGO_ENABLED=1 go test ./...'  # with the software-TPM tests
```

`attest/sim_*_test.go` run the real client against the real verifier on go-tpm-tools' simulator,
with `attest/testdata/` holding real event logs and EK certificates. `fleet/` runs a fake NetBox
and a fake Tinkerbell API in process, and `fleet/render_test.go`'s parity test runs under
`.github/scripts/talos-render-parity.sh`.
