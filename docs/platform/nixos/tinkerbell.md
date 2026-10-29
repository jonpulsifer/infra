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

1. The controller creates a `Workflow` for the device. Tinkerbell turns the `Hardware`'s `allowPXE` on, and Rufio powers the node off, sets a one-time PXE boot and powers it on.
2. UniFi's offer names the signed iPXE at the boot VIP, which dnsmasq serves on whichever anchor holds it. iPXE chains Smee's script for its MAC, and the script chains the signed HookOS UKI from nginx.
3. The `provision` Template sets the clock from the boot VIP's NTP, [attests the node](../../apps/talos-attest.md) with `images/tink-attest` when the run asks for it, wipes the `Hardware`'s disk when the run asks for it, sets the next boot, and reboots. Its other actions run `images/tink-reprovision-tools`, which carries the NTP, disk, EFI and Docker tools, so the boot VLAN needs no package mirror.
4. Tinkerbell turns `allowPXE` off, so Smee has no script for the MAC. A wiped node netboots the [signed Talos UKI's script](talos-boot.md#netboot-images), and [Talos enrollment](../../apps/talos-enroll.md) releases the config. An attested node boots its installed disk.

A node with no `Hardware` or no running `Workflow` takes step 4 directly when it PXE-boots on the bootstrap VLAN.

The firmware verifies each image against `db`. Between runs, `allowPXE` is unset or off on spore. The controller's `Hardware` leaves it out, so that an apply never turns it off during a run.

## Rules

- Keep Smee's TFTP off. It collides with dnsmasq's TFTP, and Smee then answers nothing.
- Keep Smee in `proxy` mode. HP's PXE ignores proxy offers, so UniFi's bootstrap network names the iPXE itself (`terraform/network/unifi/folly/bootstrap.tf`), and any MAC on that VLAN that PXE-boots reaches the Talos UKI.
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
