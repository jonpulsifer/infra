---
title: Metal dev env
description: A Compute Engine VM with nested virtualization that replays folly's bootstrap VLAN, its boot plane and a virtual node with a TPM, Secure Boot and a Redfish BMC, for work on provisioning without a rack.
status: unverified
---

The metal dev env is one spot VM in the `homelab-ng` project, `metal-dev`, that stands in for folly's bootstrap VLAN, the three anchors and a machine in the rack. Provisioning changes to [Talos boot](nixos/talos-boot.md), [Tinkerbell](nixos/tinkerbell.md), [Talos enrollment](../apps/talos-enroll.md), [talos-attest](../apps/talos-attest.md) and the fleet controller run here first. Nothing in it is folly's: its DevID CA, Talos secrets, NetBox and Tinkerbell API are made on the VM's first boot. No virtual node has booted through it yet.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `metalbr0` | A bridge that carries `BOOTSTRAP_CIDR`. The host owns the gateway, `SPORE_BOOTSTRAP_IP` and `BOOT_VIP` on it, so the signed images' baked addresses resolve. | the VM |
| dnsmasq and chrony | DHCP with the signed iPXE as the boot file, TFTP, DNS that answers the enrollment name with the VIP, and NTP | the VM |
| Release mirror | Downloads the newest `talos-folly/<version>-*` release every 30 minutes and verifies each signed image against `clusters/folly/talos/secureboot/` | `/var/lib/metal-dev/talos` |
| nginx | The boot files at port 80, the attest device flow under `/attest/`, and the enrollment name on 443 with a Let's Encrypt certificate from DNS-01 | the VM |
| libvirt, QEMU, OVMF, swtpm | Virtual nodes with a TPM 2.0 whose EK certificates chain to swtpm's local CA, and firmware in Setup Mode | the VM |
| sushy-tools | A Redfish BMC over libvirt, one virtual node at a time, for Rufio | container, `gateway:8000` |
| Tinkerbell | The embedded binary, as on spore, with DHCP off | the VM, API on loopback |
| NetBox | `services.netbox`, the dev system of record | `http://metal-dev.<tailnet>:8080` |
| talos-enroll, talos-attest, fleet-controller | The boot plane, pulled as `:latest` | containers on the host network |

## Rules

- Run `mise run metal-dev:up` after every start. It waits for the tailnet join and places the DNS-01 token, which is not in the image and persists on the disk at `/var/lib/metal-dev/cloudflare-token`. The token is a zone-scoped one made for this VM, in the 1Password item `cloudflare-dns01-metal-dev`, never cert-manager's.
- The VM joins the tailnet at boot as `tag:gcp`, and no tailnet key is stored anywhere. `metal-dev-tailscale-up` trades the `metal-dev` service account's Google identity token for a single-use, ephemeral auth key through the federated identity in `terraform/network/tailscale/metal_dev.tf`, as the `nixos-deploy` workflow does. `tag:gcp` reaches nothing on the tailnet; the owner reaches the VM.
- The VM reads the federated identity's client ID and audience from its `tailscale-client-id` and `tailscale-audience` metadata attributes. After an apply of `terraform/network/tailscale` that creates or replaces the identity, set its `metal_dev_client_id` and `metal_dev_audience` outputs as the `tailscale_client_id` and `tailscale_audience` defaults in `terraform/metal-dev/variables.tf`, and apply that root. While they are null the VM stays off the tailnet.
- Seed the VM's NetBox with `mise run metal-dev:seed` before an intake, never with the bare seed script, whose defaults are the lab's NetBox. Intake stops with that message when the fleet fields are missing.
- One virtual node, `vnode1`, with a fixed address and MAC. The BMC exposes one libvirt domain, and the dev cluster's endpoint is the node.
- The enrollment certificate is a real one for the lab's enrollment name, issued to this VM. Talos trusts only public roots, so a dev name would need a dev image build. Let's Encrypt issues at most five duplicates per name per week, so a VM rebuilt in a loop runs out; `terraform/metal-dev/README.md` has the rebuild steps.
- The disk is the state. A new image never replaces it, and the root refuses to destroy it; the host upgrades itself from `main` like every other host.
- Stop the VM with `mise run metal-dev:down` when done. A spot VM also stops on preemption; nothing on it needs to stay up.

## Where it lives

- `nix/hosts/metal-dev.nix`: the host, its bridge, services, containers and the `metal-dev-intake` command
- `terraform/metal-dev/`: the VPC, service account, image and VM, with `on` off by default
- `terraform/network/tailscale/metal_dev.tf`: the VM's tailnet identity
- `scripts/metal-dev/`: `up.sh`, `down.sh`, `seed.sh` and `intake.sh`
- `.github/workflows/nix-image-builder.yaml`: the `metal-dev` image, uploaded under the bucket's `metal-dev/` prefix
- `clusters/folly/config/anchor-topology.json`: `BOOTSTRAP_CIDR`, `SPORE_BOOTSTRAP_IP`, `BOOT_VIP`

## Related

- [Cloud accounts](cloud.md)
- [Talos boot](nixos/talos-boot.md)
- [Tinkerbell](nixos/tinkerbell.md)
- [Identity](identity.md)
