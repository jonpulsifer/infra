# talos-enroll

talos-enroll answers the OAuth device flow that a Talos machine runs before it
fetches `talos.config`, and releases the machine's config once NetBox's record
of its attestation, or the owner, approves it. See
[Talos enrollment](https://wiki.lolwtf.ca/apps/talos-enroll/).

## Run

```bash
go build -o talos-enroll .
talosctl gen secrets -o /tmp/secrets.yaml
ENROLL_CLASS_INPUTS=../../clusters/folly/apps/talos-enroll/class-inputs.json \
ENROLL_INVENTORY=../../clusters/folly/inventory/machines.yaml \
ENROLL_WORKER_SECRETS=/tmp/secrets.yaml \
ENROLL_DISCORD_WEBHOOK_FILE=/dev/null \
ENROLL_APPROVERS=you@example.com \
ENROLL_ADMIN_URL=http://localhost:8081 \
./talos-enroll
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENROLL_ADDR` | `:8080` | The listener Talos reaches through the anchors' nginx. `unix:<path>` makes a socket with mode 0660. |
| `ENROLL_ADMIN_ADDR` | `:8081` | The listener the owner reaches through `tailscale serve`. `unix:<path>` makes a socket with mode 0600. |
| `ENROLL_CLIENT_ID` | `talos-enroll` | The `talos.config.oauth.client_id` baked into the UKI |
| `ENROLL_SITE` | `folly` | The NetBox site whose `kubernetes-node` devices are the nodes, and the `site` of every audit line |
| `ENROLL_CLASS_INPUTS` | `/etc/talos-enroll/class-inputs.json` | Per-class render inputs, written by `mise run render-class-inputs` |
| `ENROLL_NETBOX_URL` | none | NetBox's base URL. Set, NetBox is the directory of nodes, and a staged device with an unspent attestation is approved without a click. |
| `ENROLL_NETBOX_TOKEN_FILE` | `/run/credentials/talos-enroll.service/netbox-token` | A NetBox API token that reads devices and interfaces, changes devices and adds journal entries |
| `ENROLL_INVENTORY` | none | `clusters/folly/inventory/machines.yaml`, NetBox's export: the directory when NetBox is unset or does not answer. It carries no attestation. |
| `ENROLL_ATTEST_URL` | none | The attest service's DevID listener. With `ENROLL_NETBOX_URL`, it turns on auto-approval: its verdict binds the attestation to the request. |
| `ENROLL_AUTO_APPROVE_WINDOW` | `2h` | How old an attestation may be and still approve without a click, on top of NetBox's state |
| `ENROLL_WORKER_SECRETS` | `/var/run/secrets/talos-enroll/worker-secrets/worker-secrets.yaml` | The worker subset of the cluster's secrets bundle, from `scripts/talos-worker-secrets.sh`. The full bundle is a valid superset. |
| `ENROLL_SECRETS_BUNDLE` | none | The full `talosctl gen secrets` bundle. Only a control-plane render needs it. |
| `ENROLL_DISCORD_WEBHOOK_FILE` | `/var/run/secrets/talos-enroll/discord/webhook-url` | A file holding the Discord webhook URL |
| `ENROLL_APPROVERS` | none, required | Comma-separated tailnet logins that may approve and deny |
| `ENROLL_ADMIN_URL` | none, required | The admin listener's public URL, for prompts and `verification_uri` |
| `ENROLL_TALOSCTL` | `talosctl` | The talosctl binary. It must match the Talos root's `talos_version`. |

## The directory

A node is a NetBox device of the site with the role `kubernetes-node`: its
`name` is the hostname, its `serial` the SMBIOS serial, its first interface
with a primary MAC the node's MAC, `primary_ip4` its address, and the custom
fields `talos_class`, `install_disk` and `tpm_version` what the render needs.
The device's `status`, `attest_verdict`, `last_attested` and
`attest_consumed_at` are its lifecycle, which talos-attest writes.

Each device request is looked up by the serial it claims. The prompt names
the device only when the request's MAC is the device's too. The approval page
lists every device that has a class, in any status but `decommissioning` and
`offline`, and a click on a retired device is refused.

A config release, click or not, sets `attest_consumed_at` to the release
time, which spends any attestation before it, and adds a journal entry. A
`planned` or `staged` device becomes `active`; a `failed` or retired one
keeps its status, since a release never resurrects a device. The write runs
on its own deadline, because the proxy closes the upstream once the body is
out and the request's context is done with it.

## Auto-approval

With `ENROLL_NETBOX_URL` and `ENROLL_ATTEST_URL` both set, a device request
is approved as the device its serial names, with no click, when all of these
hold:

- the request's MAC is the device's MAC
- the device has a class that is not a control plane, and its status is
  `staged`
- `attest_verdict` is `attested`, `attest_consumed_at` is unset or earlier
  than `last_attested`, and `last_attested` is within the window
- the attest service's `GET /verdict/<serial>` answers `attested`, for the
  device's name and the request's UUID
- that attestation has approved no other request since the server started

Before the token exists, the server writes `attest_consumed_at` to NetBox; a
write that fails refuses the approval, with the reason in the prompt, so a
failover or a second request cannot spend the same attestation. The Discord
note then says the machine was auto-approved after attestation. Otherwise the
request waits for a click, and its prompt says why it was not approved
automatically. Every fact in a request is the requester's claim; the
verdict's UUID is what the machine's TPM attested with, and the spend in
NetBox is what bounds a claim to one config.

## Public routes

The anchors' nginx routes only the first three. Talos sends every request
with Go's default client, and the token poll twice, with and without Basic
auth.

| Route | Does |
| --- | --- |
| `POST /device/code` | Takes `client_id`, `uuid`, `mac`, `serial`, `hostname` as a form. Answers `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in` 900 and `interval` 5. A newer request from the same `uuid` replaces the older one. A denied `uuid` gets 403 `access_denied`. |
| `POST /token` | Takes `client_id`, `grant_type` (the device code grant) and `device_code`. Answers 400 `authorization_pending`, `access_denied` or `expired_token`, or 200 with a `Bearer` token that lives 30 minutes. It ignores `Authorization`. |
| `GET /config?uuid=…` | With `Authorization: Bearer <token>`, answers 200 with the node's machine config once. A query that holds a literal `${` is 400, a `uuid` other than the token's is 403, and a used or expired token is 401. A write that fails leaves the token valid. |
| `GET /healthz` | Health check |
| `GET /metrics` | Prometheus metrics |

## Admin routes

Every route requires `Tailscale-User-Login` in `ENROLL_APPROVERS`. A POST with
an `Origin` from another host is refused.

The user code goes only to the machine, which shows it on its console. No
prompt, log, list or page carries it, so the owner approves the code read off
the console, and a device request made in another machine's name cannot be
approved by mistake.

| Route | Does |
| --- | --- |
| `GET /` | The approval page. `?code=`, from the console's QR code, fills in the code and marks its machine. |
| `GET /pending` | The waiting enrollments, without their user codes, and the nodes the directory lists, as JSON |
| `POST /approve` | Takes `code` and `node` as a form. Renders that node's config from its class, then issues the token. An unknown node is 400 with the list; a node with no class in the class inputs, or a control plane on a server without the bundle, is 409; a directory that does not answer is 502. A render that fails leaves the enrollment pending. |
| `POST /deny` | Takes `uuid` as a form. Refuses its enrollment and every later request from it until the server restarts |

## Metrics

`talos_enroll_pending`, `talos_enroll_approved_unfetched`,
`talos_enroll_waiting_machines`, `talos_enroll_longest_wait_seconds` and
`talos_enroll_classes` are gauges; the counters are `_total`.
`talos_enroll_longest_wait_seconds` runs from a machine's first device request
until approval or denial, across its codes. A machine that stays quiet for 5
minutes past its code's expiry stops counting.

## Audit

Every decision is one JSON log line with `event` set: `enroll.request`,
`enroll.approve`, `enroll.release` or `enroll.deny`, with `site`, `node`,
`serial`, `class`, `status`, `uuid`, `mac` and `approver`.

## Render

`talosctl gen config <cluster_name> <cluster_endpoint> --with-secrets /dev/stdin
--talos-version <talos_contract> --kubernetes-version <kubernetes_version>
--with-docs=false --with-examples=false -t <machine_type> -o -`, with one
`--config-patch-control-plane` or `--config-patch-worker` per patch, in this
order: the class's `config_patches`, the node document, the class's
`tpm_patches` on a node whose `tpm_version` is `2.0`, then its
`class_patches`. The node document is the hostname, the installer and install
disk, the certSAN `<node>.<dns_zone>` and the node labels, the same documents
the `talos-cluster` module renders per node. With the same inputs, the Talos
provider renders the same bytes.

A worker is rendered from a throwaway bundle that `talosctl gen secrets` makes
at start, and the six values a worker config carries, the trustd and bootstrap
tokens, the cluster id and secret, the os CA certificate and the Kubernetes CA
certificate, are then replaced with the ones in `ENROLL_WORKER_SECRETS`. Each
must occur and none may remain, or the render is refused. The server therefore
needs no CA private key for a worker. A control plane carries the CA keys, so
it is rendered from `ENROLL_SECRETS_BUNDLE`, and 409 without it.

## Test

```bash
go test ./...
```

`TestTalosctlRender` runs only where `talosctl` is on `PATH`. It proves that
the throwaway render of a worker is byte for byte the render from the full
bundle.
