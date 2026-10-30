---
title: Tinkerbell
description: The provisioning stack on spore that power-cycles, attests, wipes and reinstalls folly's Talos nodes, driven from NetBox, with its own Kubernetes API.
---

Tinkerbell is the provisioning stack on [spore](../../hosts/spore.md) that attests and reinstalls folly's Talos nodes. The `tinkerbell-embedded` binary runs it with its own kube-apiserver and etcd, outside both clusters. [fleet-controller](../../apps/fleet-controller.md) feeds it from NetBox.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| kube-apiserver and etcd | Store the `Hardware`, `Template`, `Workflow` and Rufio `Machine` objects. etcd listens on localhost. | spore, port 6443 |
| Smee | Answers PXE on `bootstrap` as a proxy DHCP server, and serves each MAC's iPXE script on port 7080 | `SPORE_BOOTSTRAP_IP` |
| Tink server and controller | Run workflows. The HookOS agent connects on port 42113. | `SPORE_BOOTSTRAP_IP` |
| Rufio | Drives each node's BMC: Intel AMT over HTTP digest auth on port 16992, or Redfish at the device's `oob_ip` | spore |
| fleet-controller | Makes the `Hardware`, `Machine` and `Workflow` objects from NetBox | spore, port 8446 |

## Boot path

Flux on folly applies `clusters/folly/tinkerbell/` to the `tinkerbell` namespace: the `provision` Template and the BMC credential Secrets. fleet-controller keeps one `Hardware` per NetBox device and one `Machine` per device with a BMC. Setting a device's `desired_action` in NetBox starts a run:

1. The controller turns the `Hardware`'s `allowPXE` on and creates a `Workflow` for the device, and Rufio powers the node off, sets a one-time PXE boot and powers it on.
2. UniFi's offer names the signed iPXE at the boot VIP, which dnsmasq serves on whichever anchor holds it. iPXE chains Smee's script for its MAC, and the script chains the signed HookOS UKI from nginx.
3. The `provision` Template sets the clock from the boot VIP's NTP, [attests the node](../../apps/talos-attest.md) with `images/tink-attest` when the run asks for it, wipes the `Hardware`'s disk when the run asks for it, sets the next boot, and reboots. Its other actions run `images/tink-reprovision-tools`, which carries the NTP, disk, EFI and Docker tools, so the boot VLAN needs no package mirror.
4. The run finishes, and the controller's next pass turns `allowPXE` off, so Smee has no script for the MAC. A wiped node netboots [iPXE's menu](talos-boot.md#netboot-images), whose default boots HookOS, and the agent waits for the next Workflow. An attested node boots its installed disk.

A node with no `Hardware` or no running `Workflow` takes step 4 directly when it PXE-boots on the bootstrap VLAN.

Every HookOS boot phones home before the agent waits for work. `images/tink-agent-autoid` runs `fleet-intake` (its `intake/` directory), which posts the machine's MAC, DMI serial, UUID, model, SKU, BIOS version and disks as JSON to the HookOS command line's `fleet_intake_url`. While it reads them, it listens on the boot NIC with an `AF_PACKET` socket for the switch's LLDP frame, which a UniFi switch sends every 30 seconds, for at most 35 seconds, and posts the frame's chassis ID, port ID, port description and system name as `lldp`, or no `lldp` when none arrives. The UKI, iPXE's menu and each `Hardware`'s script take that command line from `nix/images/hookos-folly.nix`. The client tries six times with backoff and a 10-second timeout each, logs each HTTP status but no body, and starts tink-agent whatever the answer. Each anchor's nginx passes `/fleet/intake` on the enrollment name, POST only and up to 16 KiB, to fleet-controller's port 8446 on spore's Anchor address with the machine's address in `X-Real-IP`, and logs no access (`nix/services/talos-boot.nix`). The intake is unauthenticated, so the controller keeps its address and port as diagnostics only. The attest action reports them again in the host's network namespace (the Template's `namespaces.network: host`), signed by the session's AK, and talos-attest records those on a pass; on these machines AMT shares the host's address, so the attested bootstrap address is also the AMT's. [fleet-controller](../../apps/fleet-controller.md#intake) says what the controller does with it.

HookOS sends its syslog to Smee on UDP 514 at `SPORE_BOOTSTRAP_IP`, and Smee writes it to the `tinkerbell` journal on spore, so a failed action leaves a record: read a node's with `journalctl -u tinkerbell | grep <node address>`.

The firmware verifies each image against `db`. Between runs, `allowPXE` is off on spore. The controller is its only writer: its `Workflow`s leave `toggleAllowNetboot` off, and each pass sets the flag from whether the device has an unfinished `Workflow`.

## Rules

- Keep Smee's TFTP off. It collides with dnsmasq's TFTP, and Smee then answers nothing.
- Keep Smee in `proxy` mode. HP's PXE ignores proxy offers, so UniFi's bootstrap network names the iPXE itself (`terraform/network/unifi/folly/bootstrap.tf`), and any MAC on that VLAN that PXE-boots reaches iPXE's menu.
- Keep namespaces out of `clusters/folly/tinkerbell/`. The API runs no namespace controller, so a deleted namespace stays `Terminating`.
- Keep `Hardware`, `Machine` and `Workflow` objects out of the repo. fleet-controller owns them, and deletes an object when NetBox stops exporting its device.
- Name a BMC Secret `bmc-<bmc_type>`, the NetBox field's value.
- A rerun of `scripts/tinkerbell-certs.sh` without `--client` mints a new CA and invalidates every certificate.
- Renovate bumps the version in `nix/services/tinkerbell.nix` but not the hash. Copy it from `checksums-embedded.txt`.

## Access

Port 6443 is open on `end0` and `tailscale0`. The `tinkerbell-rbac` unit lets Flux's client certificate, `folly-flux`, manage the objects in the namespace. fleet-controller uses the admin certificate.

```sh
ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get hardware,workflows,machines.bmc.tinkerbell.org
```

## Where it lives

- `nix/services/tinkerbell.nix`: the pinned binary, flags, firewall, unit, Flux's Role and the `netboot-not-allowed` TFTP links
- `nix/services/fleet-controller.nix` and `apps/fleet-controller/`: the controller
- `clusters/folly/tinkerbell/`: the `provision` Template and the BMC Secrets
- `clusters/folly/flux-system/tinkerbell.yaml`: the Flux Kustomizations
- `clusters/folly/tinkerbell-access/`: the kubeconfig, from the 1Password item `spore tinkerbell api`
- `scripts/tinkerbell-certs.sh`: the API's certificates
- `clusters/folly/config/anchor-topology.json`: `SPORE_BOOTSTRAP_IP` and `BOOT_VIP`

## Related

- [Talos boot](talos-boot.md)
- [fleet-controller](../../apps/fleet-controller.md)
- [Provision a node](../../runbooks/provision-a-node.md)
- [Reprovision a node](../../runbooks/reprovision-a-node.md)
- [Retire a node](../../runbooks/retire-a-node.md)
