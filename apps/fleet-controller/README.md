# fleet-controller

Turns a NetBox site's `kubernetes-node` devices into Tinkerbell objects.
`docs/apps/fleet-controller.md` says what it does; this file says how to run it.

## Run

```sh
FLEET_NETBOX_URL=http://capsule:8080 \
FLEET_NETBOX_TOKEN_FILE=/run/credentials/fleet-controller.service/netbox-token \
FLEET_KUBE_CA_FILE=ca.crt FLEET_KUBE_CERT_FILE=admin.crt FLEET_KUBE_KEY_FILE=admin.key \
FLEET_HOOKOS_URL=http://10.9.0.11/talos/folly/hookos-amd64-secureboot-uki.efi \
FLEET_HOOKOS_CMDLINE='facility= ...' \
FLEET_ATTEST_URL=http://10.9.0.14/attest FLEET_NTP_SERVER=10.9.0.14 \
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
| `FLEET_WEBHOOK_ADDR` | `:8446` | The listener for `/webhook`, `/healthz` and `/metrics` |
| `FLEET_WEBHOOK_SECRET_FILE` | none | NetBox's event-rule secret; without it `/webhook` answers 503 and the controller only polls |
| `FLEET_INTERVAL` | `2m` | Time between passes |
| `FLEET_WORKFLOW_TTL` | `168h` | Age at which the controller deletes its Workflows |

## NetBox contract

Devices with role `kubernetes-node` and status `planned`, `staged`, `active`,
`failed` or `decommissioning`. Read: `name`, `serial`, `status`,
`primary_ip4`, `oob_ip`, the first physical interface's `primary_mac_address`,
and the custom fields `install_disk`, `talos_class`, `tpm_version`,
`bmc_type`, `desired_action`, `last_workflow`. A select field may be a string
or a `{value, label}` object. Written: `desired_action` (back to `none`),
`last_workflow`, `status` (`staged` on a provision or wipe, `offline` after a
retirement) and journal entries. A retirement is the `retire` run, which
powers the node off; the controller starts it on status `decommissioning`,
never from `desired_action`.

The webhook is `POST /webhook` with NetBox's `X-Hook-Signature`, HMAC-SHA512
hex of the body with the rule's secret. The body is not read for content: a
good signature queues one reconcile, debounced two seconds and spaced at
least five seconds apart.

## Test

```sh
go test ./...
```

The tests run a fake NetBox and a fake kube-apiserver in-process.
