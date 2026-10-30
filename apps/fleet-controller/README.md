# fleet-controller

Turns a NetBox site's `kubernetes-node` devices into Tinkerbell objects, takes a new machine's intake, and
renders the Talos config an install fetches.
`docs/apps/fleet-controller.md` says what it does; this file says how to run it.

## Run

```sh
FLEET_NETBOX_URL=http://capsule:8080 \
FLEET_NETBOX_TOKEN_FILE=/run/credentials/fleet-controller.service/netbox-token \
FLEET_KUBE_CA_FILE=ca.crt FLEET_KUBE_CERT_FILE=admin.crt FLEET_KUBE_KEY_FILE=admin.key \
FLEET_HOOKOS_URL=http://10.9.0.11/talos/folly/hookos-amd64-secureboot-uki.efi \
FLEET_HOOKOS_CMDLINE='facility= ...' \
FLEET_ATTEST_URL=https://enroll.lolwtf.ca/attest FLEET_NTP_SERVER=10.9.0.14 \
go run .
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEET_SITE` | `folly` | The NetBox site |
| `FLEET_NETBOX_URL`, `FLEET_NETBOX_TOKEN_FILE` | required | NetBox and a token that reads and changes `dcim.device` and adds journal entries |
| `FLEET_KUBE_SERVER` | `https://localhost:6443` | Tinkerbell's kube-apiserver |
| `FLEET_KUBE_CA_FILE`, `FLEET_KUBE_CERT_FILE`, `FLEET_KUBE_KEY_FILE` | `/etc/tinkerbell/{ca,admin}.{crt,key}` | Its CA and a client certificate that manages `hardware`, `machines` and `workflows` |
| `FLEET_NAMESPACE` | `tinkerbell` | The namespace the controller owns objects in |
| `FLEET_TEMPLATE` | `provision` | The Template every Workflow runs |
| `FLEET_HOOKOS_URL`, `FLEET_HOOKOS_CMDLINE` | required | The signed HookOS UKI and the command line its iPXE chain passes |
| `FLEET_ATTEST_URL`, `FLEET_NTP_SERVER` | required | talos-attest's device flow and the NTP server, both in each Workflow's `hardwareMap` |
| `FLEET_BMC_SECRETS` | `amt=bmc-amt,redfish=bmc-redfish` | The Secret per `bmc_type` that a Machine's `authSecretRef` names |
| `FLEET_REDFISH_PORT`, `FLEET_REDFISH_INSECURE_TLS` | `443`, `false` | Redfish connection options |
| `FLEET_WEBHOOK_ADDR` | `:8446` | The listener for `/webhook`, `/render`, `/intake`, `/healthz` and `/metrics` |
| `FLEET_WEBHOOK_SECRET_FILE` | none | NetBox's event-rule secret; without it `/webhook` answers 503 and the controller only polls |
| `FLEET_INTERVAL` | `2m` | Time between passes |
| `FLEET_WORKFLOW_TTL` | `168h` | Age at which the controller deletes its Workflows |
| `FLEET_ATTEST_SECRET_FILE` | none | talos-attest's render secret; without it `/render` answers 503 |
| `FLEET_CLASS_INPUTS`, `FLEET_WORKER_SECRETS`, `FLEET_TALOSCTL` | none | The class inputs, the worker subset of the secrets bundle and talosctl; all three or none. Without them `/render` answers 503 and no Workflow installs |
| `FLEET_STATE_DIR` | `/var/lib/fleet-controller` | Where rendered configs go, as `talos/<uuid>/<code>.yaml`, with the log offset and the spent codes |
| `FLEET_CONFIG_LOG` | `/var/log/nginx/fleet/talos-config.log` | nginx's log of `/talos/config`, in the `fleet` format `$time_iso8601 $arg_uuid $arg_code $status $request_method $request_completion $body_bytes_sent` |
| `FLEET_INSTALLS` | `false` | Whether a rendered class's provision Workflow installs; off, `/render` refuses every call, since no run asks for one |
| `FLEET_CONFIG_TTL` | `2h` | Age at which an unfetched config is deleted |
| `FLEET_CONTROLPLANE_BUNDLE` | none | The full secrets bundle; with it a control-plane class renders and installs too. It must hold every CA key and the worker subset's values, and needs the renderer and `FLEET_BOOTSTRAP_ADDRESS` |
| `FLEET_BOOTSTRAP_ADDRESS` | none | The address of the control plane the Talos root bootstraps etcd on, `API_SERVER_IP`; a device there never installs, and `/render` refuses it |
| `FLEET_CONTROLPLANE_CONFIG_TTL` | `30m` | Age at which an unfetched control-plane config is deleted |
| `FLEET_AUTO_PROVISION` | `false` | Whether a bound intake with a class and an address gets `desired_action` `provision`; the Nix module sets `true` |
| `FLEET_MODEL_MAP` | the G5 mini as `worker-g5`, `amt`, `/dev/nvme0n1` | JSON `{"<SMBIOS model>": {"class", "bmc", "disk"}}` for an intake |
| `FLEET_NODE_PREFIX`, `FLEET_NODE_RESERVED` | none | The prefix an intake's address comes from, `K8S_NODE_CIDR`, and a comma list of addresses in it that never go to a node; without the prefix an intake gets no free address |
| `FLEET_INTAKE_PORT` | required | The provisioning station's switch port; the controller refuses to start without one. The Nix module reads `provisioning` in `quarantine_ports` of `terraform/network/unifi/<site>/bootstrap.tf` |
| `FLEET_INTAKE_TTL` | `24h` | Age at which an intake no device holds is deleted |
| `FLEET_PROXY_ADDRESSES` | none | Comma list of the intake proxies' addresses, the anchors' Anchor addresses: a call from one names the machine's address in `X-Real-IP`. Without it every caller is the machine |
| `FLEET_BOOTSTRAP_CIDR`, `FLEET_BOOTSTRAP_RESERVED` | none | The bootstrap network and a comma list of addresses in it that are no machine's, the anchors' and the boot VIP. Without the prefix no attested address puts a Machine on the bootstrap network |

## NetBox contract

Devices with role `kubernetes-node` and status `planned`, `staged`, `active`,
`failed` or `decommissioning`. Read: `name`, `serial`, `status`,
`primary_ip4`, `oob_ip`, the first physical interface's `primary_mac_address`,
and the custom fields `install_disk`, `talos_class`, `tpm_version`,
`bmc_type`, `amt`, `secure_boot_expected`, `desired_action`,
`last_workflow`, and talos-attest's
`attested_address`, `attested_switch`, `attested_switch_port` and
`attested_network_at`. A select field may be a string
or a `{value, label}` object. Written: `desired_action` (back to `none`),
`last_workflow`, `status` (`staged` when a provision or wipe starts on an
`active` or `failed` device, `offline` after a retirement) and journal
entries. A `planned` device stays `planned` through its first provision:
talos-attest grants the no-click first intake only in that status and moves
the device to `staged` itself on the verdict. A `planned` device also boots
by hand: its Workflow carries no `bootMode`, its journal entry says to power
the machine on, and it gets a Machine only with an explicit `oob_ip`, since
an AMT address derived from a Kubernetes address it does not hold yet is
wrong. The exception is a `planned` or `staged` `amt` device without
`oob_ip` whose `attested_address` is inside `FLEET_BOOTSTRAP_CIDR`, not in
`FLEET_BOOTSTRAP_RESERVED`, and whose `attested_network_at` is younger than
15 minutes: its Machine dials that address, and a new Workflow has `bootMode`
`netboot` and the address in `lolwtf.ca/bmc-address`. While that Workflow is
unfinished, the Machine keeps the pinned address, however old the attested
one grows, unless a pass during the run attests another: another bootstrap
address moves the Machine there, and any other address, such as the
device's own once its RADIUS user moves it, ends the pin. The Machine and Rufio come for every other device once the status
leaves `planned`. A retirement is the `retire` run, which
powers the node off; the controller starts it on status `decommissioning`,
never from `desired_action`.

`smbios_uuid` is read to journal a fetch with a wrong code on its device.
`attest_consumed_at` and `status` (`active`) are written when nginx serves a
device's config.

## Render contract

`POST /render` with `{"serial", "uuid", "node", "class", "code"}`, signed with
`X-Fleet-Signature`, HMAC-SHA512 hex of the body with the attest secret. The
`uuid` is the SMBIOS UUID in lower case and the `code` 43 characters of
base64url; anything else is 400 before a path is built. 401 is a bad
signature. 409 is a device that is unknown, not `planned` or `staged`, without
an unfinished `provision` run with `install=true` in `last_workflow`, of
another node, class or `smbios_uuid` than the body names, or a code already
spent. It is also a control plane without `FLEET_CONTROLPLANE_BUNDLE`, or one
at `FLEET_BOOTSTRAP_ADDRESS` or with no address. 503 is a render the controller cannot do now, with the detail in its
log. 201 means the file is written. Every answer is `{"reason": "..."}`,
which never repeats the request.

A whole GET (`200`, `GET`, `OK`, the file's size in bytes) burns the file. A
served, expired or replaced code is kept as a hash for 24 hours in
`talos-burned.json`, and a render for it is refused.

## Intake contract

`POST /intake`, unauthenticated, at most 16 KiB of JSON: `{"mac", "serial",
"uuid", "model", "sku", "bios", "disks": [{"name", "size", "tran"}], "lldp":
{"chassis_id", "port_id", "port_description", "system_name"}}`, with `size`
in bytes and `lldp` optional. 400 is a MAC that is not unicast
`aa:bb:cc:dd:ee:ff`, a serial that is not 1 to 64 printable ASCII characters,
a UUID of another shape, or a disk that is not a kernel name. An `lldp`
without a chassis ID and a port ID, or with more than 255 printable ASCII
characters in a field, is dropped and the call goes on. The machine's
address is `X-Real-IP` when the peer is in `FLEET_PROXY_ADDRESSES`, else the
peer; a proxy call without the header has none. 429 is a second call for a
MAC within ten minutes, an 11th call in an hour from one address, or a 21st
intake made in an hour; a call that made nothing, a known MAC's included,
gives its MAC's slot back.

Each call's report is a claim, kept for diagnostics: no Machine, cable or
port check follows from it. It is annotations on each of the controller's
`Hardware` with the MAC, merge-patched by the field manager
`fleet-controller-intake` so the controller's own apply leaves them: `lolwtf.ca/intake-at` (RFC 3339), `lolwtf.ca/intake-address`,
`lolwtf.ca/intake-serial`, and `lolwtf.ca/lldp-chassis-id`, `-port-id`,
`-port-description`, `-system-name`. A report without an address or LLDP
removes the older one. 200 `{"state":"known"}` is a MAC that a NetBox
interface or a `Hardware` holds. 201 `{"state":"intake","workflow":"intake-<mac>-<unix seconds>"}` made
`Hardware <mac>` (labels `lolwtf.ca/intake=true` and the managed and node
labels; the report and `lolwtf.ca/intake-uuid` and `-model`; the first NVMe
disk, else the first non-USB one, else the model's) and the `Workflow` with
`attest=true`, `wipe=false`, `install=false` and no `bootMode`. 503 is a
NetBox or Tinkerbell failure. Audit line `fleet.intake`, with the report.

## Binding contract

A pass binds a device that is `staged` with `attest_verdict` `attested` once
the newest `Workflow` of the intake holding its MAC has finished. Only a MAC
talos-attest wrote binds: an attested device with none is journaled once and
waits, and an intake's claimed MAC is never written to NetBox. A device of any
other status drops an intake that has stopped running. A failed intake goes
after an hour, and one no device holds after `FLEET_INTAKE_TTL`. A stub is a
`planned` device with no MAC; one that a bind marker names is promised. An `intake-*` device takes the stub
with its serial, else the oldest (lowest id) serial-less stub whose
`talos_class` is the model's, then the stub's name and `expected_port`; the
description `fleet-controller: binds stub <name>` carries the name across a
pass that stops between deleting the stub and the rename. The machine's
port is the `Port <n>` its `attested_switch_port` names, recorded no earlier
than the intake's Workflow, on the NetBox switch whose interface MAC is its
`attested_switch`. Off `FLEET_INTAKE_PORT`, an `expected_port` other than that
port, or no port, refuses the binding: nothing is written and the journal
says `on port N, expected M`. A port the intake claimed that differs is noted
in the binding's journal entry.
Written, each only when it differs: `talos_class`, `bmc_type`, `install_disk` (the model map's, never the claim's),
`expected_port`, `last_workflow` (the intake run), `primary_ip4` (the unassigned IP address whose DNS name is
the device's new name, else the lowest free address of `FLEET_NODE_PREFIX`
outside `FLEET_NODE_RESERVED`), the name, a cable
to the switch port (on the intake port, to `expected_port` only), and
`desired_action` `provision`. A cable never takes a switch port another
device's cable holds: the other cable stays, and the journal says so. The
intake's objects are deleted last. A device whose `last_workflow` is an
intake run gets a `Workflow` without `bootMode`, since it waits in HookOS. Audit lines `fleet.bind` and
`fleet.autoprovision`. A `staged` or `active` device whose interface has no
cable is cabled to the port an `attested_network_at` younger than an hour
names, unless that is the intake port, and one attested off its
`expected_port` is journaled once.

The webhook is `POST /webhook` with NetBox's `X-Hook-Signature`, HMAC-SHA512
hex of the body with the rule's secret. The body is not read for content: a
good signature queues one reconcile, debounced two seconds and spaced at
least five seconds apart.

## Test

```sh
go test ./...
```

The tests run a fake NetBox and a fake kube-apiserver in-process.
