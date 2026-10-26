---
title: Tinkerbell
description: The provisioning stack on spore that network boots folly's Talos nodes, with its own Kubernetes API.
---

Tinkerbell is the bare-metal provisioning stack on [spore](../../hosts/spore.md) that power-cycles, wipes and network boots folly's Talos nodes. The `tinkerbell-embedded` binary runs it with its own kube-apiserver and etcd, so it depends on neither cluster.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| kube-apiserver and etcd | Store the `Hardware`, `Template`, `Workflow` and Rufio `Machine` objects. etcd listens on localhost. | spore, port 6443 |
| Smee | Answers PXE on `bootstrap` as a proxy DHCP server, and serves each MAC's iPXE script on port 7080 | `SPORE_BOOTSTRAP_IP` |
| Tink server and controller | Run workflows. The HookOS agent connects on port 42113. | `SPORE_BOOTSTRAP_IP` |
| Rufio | Drives each node's BMC | spore |

The UI, Tootles, SecondStar and Smee's own TFTP and iPXE binaries are off.

## Boot path

Firmware PXE on the bootstrap VLAN takes its address from UniFi, whose DHCP names no boot file. Smee answers only a MAC that has a `Hardware` object, and names `talos/folly/ipxe-amd64-secureboot.efi` on spore's bootstrap address. dnsmasq serves that file from `/var/lib/tftpboot`, and nginx serves the signed HookOS UKI at `/talos/folly/hookos-amd64-secureboot-uki.efi`. The signed iPXE then fetches the node's script from `http://<SPORE_BOOTSTRAP_IP>:7080/ipxe/script/<mac>/auto.ipxe`.

Every `Hardware` object has `allowPXE` and `allowWorkflow` off, so no node boots this path today.

## Objects

Flux on folly applies `clusters/folly/tinkerbell/` to the `tinkerbell` namespace on spore. The `tinkerbell` Kustomization in `clusters/folly/flux-system/tinkerbell.yaml` reaches the API with the Secret `spore-tinkerbell-kubeconfig`. An ExternalSecret in `clusters/folly/tinkerbell-access/` builds it from the 1Password item `spore tinkerbell api`.

| Object | One per | Source |
| --- | --- | --- |
| `Hardware` | folly node | `nodes.env`, which `mise run render-tinkerbell-nodes` writes from `terraform/network/unifi/folly/clients.yaml` and `NODE_ADDRESSES` |
| Rufio `Machine` | node with AMT | AMT over HTTP digest auth on port 16992 |
| Secret `amt` | site | `amt.sops.yaml`, from the 1Password item `AMT MEBx credentials` |

Rufio polls each `Machine` and records its power state:

```sh
ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get hardware,machines.bmc.tinkerbell.org -o wide
```

## API access

The API listens on every address. spore's firewall admits port 6443 on `end0` (Lab Net) and `tailscale0`. Tailscale's own rules admit tailnet traffic first, so the tailnet policy filters it. The controller manager listens on port 10257 on every address, and no rule admits it.

A client authenticates with a certificate from the API's CA, and RBAC authorizes it. Anonymous requests get 401. Tinkerbell's own services and `/etc/tinkerbell/kubeconfig` use a `system:masters` certificate. Flux's certificate has CN `folly-flux`. The `tinkerbell-rbac` unit creates the `tinkerbell` namespace and binds `folly-flux` to a Role there that manages `Hardware`, `Template`, `Machine` and Secret objects. It re-applies both each time Tinkerbell starts.

## Rules

- Keep Smee's TFTP off. It collides with dnsmasq's TFTP, and Smee then answers nothing.
- Keep the bootstrap network's DHCP boot options off in UniFi. EDK2 takes the file in Smee's proxy offer, so a UniFi file reaches only the MACs that Smee ignores.
- Keep Smee in `proxy` mode. `auto-proxy` answers every PXE client on the VLAN.
- spore never holds the CA key. `scripts/tinkerbell-certs.sh --client <name>` issues a client certificate from the 1Password item `spore tinkerbell api`.
- Keep namespaces out of `clusters/folly/tinkerbell/`. The API runs no namespace controller, so a deleted namespace stays `Terminating`.
- Run `mise run render-tinkerbell-nodes` after a node's MAC or address changes. CI fails while `nodes.env` is stale.
- Reach AMT over HTTP. AMT's TLS offers only RSA key exchange, which Go's TLS client refuses.
- `scripts/tinkerbell-certs.sh` mints a new CA, so a rerun invalidates every client certificate.
- Renovate bumps the version in `nix/services/tinkerbell.nix` but not the hash. Copy the hash from the release's `checksums-embedded.txt`.
- The `spore-reliability` check fails if Smee leaves `proxy` mode or `bootstrap`, turns TFTP on, or port 6443 opens on `bootstrap`.

## Where it lives

- `nix/services/tinkerbell.nix`: the pinned binary, flags, firewall and unit
- `nix/secrets/spore.sops.yaml`: the certificates and service-account key under `tinkerbell`
- `scripts/tinkerbell-certs.sh`: mints them into SOPS and 1Password, and issues client certificates
- `clusters/folly/tinkerbell/`: the `Hardware`, `Machine` and Secret objects
- `terraform/network/unifi/folly/bootstrap.tf`: the bootstrap network's DHCP
- `clusters/folly/config/lab-topology.json`: `SPORE_BOOTSTRAP_IP`, `SPORE_IP`

## Related

- [Talos boot](talos-boot.md)
- [Enroll a Talos node](../../runbooks/enroll-a-talos-node.md)
- [Manage SOPS secrets](../../runbooks/manage-sops-secrets.md)
