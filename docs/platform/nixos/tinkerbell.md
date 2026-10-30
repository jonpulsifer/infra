---
title: Tinkerbell
description: The provisioning stack on spore that power-cycles, wipes and reinstalls folly's Talos nodes, driven by fleetd from NetBox, with its own Kubernetes API.
---

Tinkerbell is the provisioning stack on [spore](../../hosts/spore.md) that reinstalls folly's Talos nodes. The `tinkerbell-embedded` binary runs it with its own kube-apiserver and etcd, outside both clusters. [fleetd](../../apps/fleetd.md) feeds it from NetBox.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| kube-apiserver and etcd | Store the `Hardware`, `Template`, `Workflow` and Rufio `Machine` objects. etcd listens on localhost. | spore, port 6443 |
| Smee | Answers PXE on `bootstrap` as a proxy DHCP server, and serves each MAC's iPXE script on port 7080 | `SPORE_BOOTSTRAP_IP` |
| Tink server and controller | Run workflows. The HookOS agent connects on port 42113. | `SPORE_BOOTSTRAP_IP` |
| Rufio | Drives each node's BMC: Intel AMT over HTTP digest auth on port 16992 | spore |
| fleetd | Makes the `Hardware`, `Machine` and `Workflow` objects from NetBox and from intake passes | spore |

## Boot path

Flux on folly applies `clusters/folly/tinkerbell/` to the `tinkerbell` namespace: the `provision` Template and the BMC credential Secrets. fleetd keeps one `Hardware` per NetBox device and one `Machine` per device with a BMC. Setting a device's `desired_action` in NetBox starts a run:

1. fleetd turns the `Hardware`'s `allowPXE` on and creates a `Workflow` for the device, and Rufio powers the node off, sets a one-time PXE boot and powers it on.
2. UniFi's offer names the signed iPXE at spore's bootstrap address, which dnsmasq serves. iPXE chains Smee's script for its MAC, and the script chains the signed HookOS UKI from nginx.
3. HookOS's agent image sets the clock from spore's NTP and [attests the node](../../apps/fleetd.md) before tink-agent waits. An intake pass of a `provision` gets the install code.
4. The `provision` Template wipes the `Hardware`'s disk when the run asks for it, installs Talos with the code when it asks for that, sets the next boot, and reboots. Its actions run `images/tink-reprovision-tools`, which carries the disk, EFI and Docker tools, so the boot VLAN needs no package mirror.
5. The run finishes, and fleetd's next pass turns `allowPXE` off, so Smee has no script for the MAC. A wiped node netboots [iPXE's menu](talos-boot.md#netboot-images), whose default boots HookOS, which attests, and the agent waits for the next Workflow. An installed node boots its disk.

A node with no `Hardware` or no running `Workflow` takes step 5 directly when it PXE-boots on the Kubernetes network. A declared `planned` device that attests there is admitted, and fleetd starts its provision without a boot mode, since the machine already waits in HookOS.

Every HookOS boot attests before the agent waits for work. `images/tink-agent-autoid`'s entrypoint runs privileged in the host's network namespace with HookOS's `/worker` mounted, as hook-bootkit starts it. It sets the clock from `fleet_ntp_server`, mounts securityfs, and runs `tink-attest` against `fleet_attest_url` up to five times, 30 seconds apart. `tink-attest` reports the boot NIC's address and the switch's LLDP frame, signed by the session's AK; on these machines AMT shares the host's NIC. It leaves an install code in `/worker/fleet/install_code`, which the Template's install action mounts as `/tmp/fleet`. The UKI, iPXE's menu and each `Hardware`'s script take that command line from `nix/images/hookos-folly.nix`. [fleetd](../../apps/fleetd.md#how-it-works) says what an intake pass does.

HookOS sends its syslog to Smee on UDP 514 at `SPORE_BOOTSTRAP_IP`, and Smee writes it to the `tinkerbell` journal on spore, so a failed action leaves a record: read a node's with `journalctl -u tinkerbell | grep <node address>`.

The firmware verifies each image against `db`. Between runs, `allowPXE` is off on spore. fleetd is its only writer: its `Workflow`s leave `toggleAllowNetboot` off, and each pass sets the flag from whether the device has an unfinished `Workflow`.

## Rules

- Keep Smee's TFTP off. It collides with dnsmasq's TFTP, and Smee then answers nothing.
- Keep Smee in `proxy` mode. HP's PXE ignores proxy offers, so the Kubernetes network's DHCP names the iPXE itself (`boot_option` in `terraform/network/unifi/folly/bootstrap.tf`), and any MAC on a node port that PXE-boots reaches iPXE's menu.
- Keep namespaces out of `clusters/folly/tinkerbell/`. The API runs no namespace controller, so a deleted namespace stays `Terminating`.
- Keep `Hardware`, `Machine` and `Workflow` objects out of the repo. fleetd owns them, and deletes an object when NetBox stops exporting its device.
- Name a BMC Secret `bmc-<bmc_type>`, the NetBox field's value.
- A rerun of `scripts/tinkerbell-certs.sh` without `--client` mints a new CA and invalidates every certificate.
- Renovate bumps the version in `nix/services/tinkerbell.nix` but not the hash. Copy it from `checksums-embedded.txt`.

## Access

Port 6443 is open on `end0` and `tailscale0`. The `tinkerbell-rbac` unit lets Flux's client certificate, `folly-flux`, manage the objects in the namespace. fleetd uses the admin certificate.

```sh
ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get hardware,workflows,machines.bmc.tinkerbell.org
```

## Where it lives

- `nix/services/tinkerbell.nix`: the pinned binary, flags, firewall, unit, Flux's Role and the `netboot-not-allowed` TFTP links
- `nix/services/fleetd.nix` and `apps/fleetd/`: fleetd
- `clusters/folly/tinkerbell/`: the `provision` Template and the BMC Secrets
- `clusters/folly/flux-system/tinkerbell.yaml`: the Flux Kustomizations
- `clusters/folly/tinkerbell-access/`: the kubeconfig, from the 1Password item `spore tinkerbell api`
- `scripts/tinkerbell-certs.sh`: the API's certificates
- `clusters/folly/config/anchor-topology.json`: `SPORE_BOOTSTRAP_IP`

## Related

- [Talos boot](talos-boot.md)
- [fleetd](../../apps/fleetd.md)
- [Provision a node](../../runbooks/provision-a-node.md)
- [Reprovision a node](../../runbooks/reprovision-a-node.md)
- [Retire a node](../../runbooks/retire-a-node.md)
