---
title: Tinkerbell
description: The provisioning stack on spore that power-cycles, wipes and reinstalls folly's Talos nodes, with its own Kubernetes API.
---

Tinkerbell is the provisioning stack on [spore](../../hosts/spore.md) that reinstalls folly's Talos nodes. The `tinkerbell-embedded` binary runs it with its own kube-apiserver and etcd, outside both clusters.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| kube-apiserver and etcd | Store the `Hardware`, `Template`, `Workflow` and Rufio `Machine` objects. etcd listens on localhost. | spore, port 6443 |
| Smee | Answers PXE on `bootstrap` as a proxy DHCP server, and serves each MAC's iPXE script on port 7080 | `SPORE_BOOTSTRAP_IP` |
| Tink server and controller | Run workflows. The HookOS agent connects on port 42113. | `SPORE_BOOTSTRAP_IP` |
| Rufio | Drives each node's Intel AMT over HTTP digest auth on port 16992 | spore |

## Boot path

Flux on folly applies `clusters/folly/tinkerbell/` to the `tinkerbell` namespace. A pull request that adds a `Workflow` there starts a [reprovision](../../runbooks/reprovision-a-talos-node.md):

1. The controller turns the `Hardware`'s `allowPXE` on. Rufio powers the node off, sets a one-time PXE boot and powers it on.
2. UniFi's offer names the signed iPXE at the boot VIP, which dnsmasq serves on whichever anchor holds it. iPXE chains Smee's script for its MAC, and the script chains the signed HookOS UKI from nginx.
3. The `reprovision-talos` Template wipes the `Hardware`'s disk, makes the IPv4 network boot entry the next boot, and reboots. Its actions run `images/tink-reprovision-tools`, which carries the disk, EFI and Docker tools, so the boot VLAN needs no package mirror.
4. The controller turns `allowPXE` off, so Smee has no script for the MAC. iPXE chains the [signed Talos UKI's script](talos-boot.md#netboot-images), and [Talos enrollment](../../apps/talos-enroll.md) releases the config.

A `Workflow` labelled `tinkerbell.lolwtf.ca/template=attest` runs the `attest-to-disk` Template in step 3 instead: it [attests the node](../../runbooks/attest-a-node.md) with `images/tink-attest`, makes the disk the next boot, and reboots with nothing wiped.

A node with no `Hardware` or no running `Workflow` takes step 4 directly when it PXE-boots on the bootstrap VLAN.

The firmware verifies each image against `db`. Between runs, `allowPXE` is unset or off on spore. The repo leaves it out, so that Flux never turns it off during a run.

## Rules

- Keep Smee's TFTP off. It collides with dnsmasq's TFTP, and Smee then answers nothing.
- Keep Smee in `proxy` mode. HP's PXE ignores proxy offers, so UniFi's bootstrap network names the iPXE itself (`terraform/network/unifi/folly/bootstrap.tf`), and any MAC on that VLAN that PXE-boots reaches the Talos UKI.
- Keep namespaces out of `clusters/folly/tinkerbell/`. The API runs no namespace controller, so a deleted namespace stays `Terminating`.
- Remove a reprovision `Workflow` from the repo after its run. Flux creates it again after an etcd loss, and it wipes the node again.
- Run `mise run render-tinkerbell-nodes` after a node's MAC, address or install disk changes. CI fails while `nodes.env` is stale.
- A rerun of `scripts/tinkerbell-certs.sh` without `--client` mints a new CA and invalidates every certificate.
- Renovate bumps the version in `nix/services/tinkerbell.nix` but not the hash. Copy it from `checksums-embedded.txt`.

## Access

Port 6443 is open on `end0` and `tailscale0`. The `tinkerbell-rbac` unit lets Flux's client certificate, `folly-flux`, manage the objects in the namespace.

```sh
ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get hardware,workflows,machines.bmc.tinkerbell.org
```

## Where it lives

- `nix/services/tinkerbell.nix`: the pinned binary, flags, firewall, unit, Flux's Role and the `netboot-not-allowed` TFTP links
- `clusters/folly/tinkerbell/`: the `Hardware`, `Machine`, Secret and `Template` objects, and `nodes.env`
- `clusters/folly/flux-system/tinkerbell.yaml`: the Flux Kustomizations
- `clusters/folly/tinkerbell-access/`: the kubeconfig, from the 1Password item `spore tinkerbell api`
- `scripts/tinkerbell-certs.sh`: the API's certificates
- `clusters/folly/config/anchor-topology.json`: `SPORE_BOOTSTRAP_IP`

## Related

- [Talos boot](talos-boot.md)
- [Reprovision a Talos node](../../runbooks/reprovision-a-talos-node.md)
- [Enroll a Talos node](../../runbooks/enroll-a-talos-node.md)
