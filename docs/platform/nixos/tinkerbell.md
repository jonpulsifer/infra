---
title: Tinkerbell
description: The provisioning stack on spore that power-cycles, wipes and reinstalls folly's Talos nodes, driven by fleetd from NetBox, with its own Kubernetes API.
---

Tinkerbell is the provisioning stack on [spore](../../hosts/spore.md) that reinstalls folly's Talos nodes. The `tinkerbell-embedded` binary runs it with its own kube-apiserver and etcd, outside both clusters. [fleetd](../../apps/fleetd.md) feeds it from NetBox.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| kube-apiserver and etcd | Store the `Hardware`, `Template`, `Workflow` and Rufio `Machine` objects. etcd listens on localhost. | spore, port 6443 |
| Smee | Off on spore, by `homelab.tinkerbell.smee.enable`. On, it answers PXE on `bootstrap` as a proxy DHCP server unless `homelab.tinkerbell.smee.dhcp` is off, serves each MAC's iPXE script on port 7080 and receives HookOS's syslog | `SPORE_BOOTSTRAP_IP` |
| Tink server and controller | Run workflows. The HookOS agent connects to `enroll.lolwtf.ca:42113` over TLS, with the enrollment name's certificate from `nix/services/fleetd.nix`. | `SPORE_BOOTSTRAP_IP` |
| Rufio | Drives each node's BMC: Intel AMT over HTTP digest auth on port 16992 | spore |
| fleetd | Makes the `Hardware`, `Machine` and `Workflow` objects from NetBox and from intake passes | spore |

## Boot path

Flux on folly applies `clusters/folly/tinkerbell/` to the `tinkerbell` namespace: the `provision` and `provision-image` Templates and the BMC credential Secrets. fleetd keeps one `Hardware` per NetBox device and one `Machine` per device with a BMC. Setting a device's `desired_action` in NetBox starts a run:

1. fleetd turns the `Hardware`'s `allowPXE` on and creates a `Workflow` for the device, and Rufio powers the node off, sets a one-time PXE boot and powers it on.
2. UniFi's offer names the signed iPXE at spore's bootstrap address, which dnsmasq serves. iPXE's menu chains the signed HookOS UKI from nginx.
3. HookOS's agent image sets the clock from spore's NTP and [attests the node](../../apps/fleetd.md) before tink-agent waits. An intake pass of a `provision` gets the install code. The agent then takes its actions from the Tink server over TLS; its signed command line names the server and `tinkerbell_tls=true`, so no host on the Kubernetes network can stand in for it. The agent itself holds no credential, so fleetd corroborates a retirement's reported success with the BMC's power state.
4. The `provision` Template wipes the `Hardware`'s disk when the run asks for it, installs Talos with the code when it asks for that, sets the next boot, and reboots. Its actions run `images/tink-reprovision-tools`, which carries the disk, EFI and Docker tools, so the boot VLAN needs no package mirror.
5. The run finishes, and fleetd's next pass turns `allowPXE` off. A wiped node netboots [iPXE's menu](talos-boot.md#netboot-images), whose default boots HookOS, which attests, and the agent waits for the next Workflow. An installed node boots its disk.

A class whose payload is a disk image runs the `provision-image` Template (`template-image.yaml`) in place of `provision`. It wipes the same way, then downloads the class's image into RAM, checks its sha256 against the class's digest, and writes it to the disk. For a `nixos-image` or `alpine-image` payload it puts `fleet-seed.json` (the seed URL, the node's UUID and the install code) on the image's EFI system partition, and the node's first boot fetches its seed. For a `cloud-init-nocloud` payload it fetches the seed in HookOS and extracts it to `var/lib/cloud/seed/nocloud` on the root partition, so the device turns `active` when the install wrote the seed. `next-boot` creates a `fleet <os>` firmware entry for the image's loader, which sits at the removable path.

A node with no `Hardware` or no running `Workflow` takes step 5 directly when it PXE-boots on the Kubernetes network. A declared `planned` device that attests there is admitted, and fleetd starts its provision without a boot mode, since the machine already waits in HookOS.

### Attestation before work

Every HookOS boot attests before the agent waits for work. hook-bootkit starts the `images/tink-agent-autoid` entrypoint with these privileges:

- The container is privileged.
- It uses the host network namespace.
- It mounts HookOS's `/worker` directory.

The entrypoint sets the clock from `fleet_ntp_server` and mounts securityfs. It calls `tink-attest` at `fleet_attest_url` up to five times, with 30 seconds between attempts.

`tink-attest` reports the boot NIC address and the switch's LLDP frame. The session's AK signs the report. On these machines, AMT shares the host NIC.

The install code goes in `/worker/fleet/install_code`. The Template's install action mounts that directory at `/tmp/fleet`.

The UKI, iPXE menu and Hardware scripts use the command line from `nix/images/hookos-folly.nix`. [fleetd](../../apps/fleetd.md#how-it-works) explains intake.

### Logs and PXE state

HookOS sends its syslog to UDP 514 at `SPORE_BOOTSTRAP_IP`, where rsyslog (`nix/services/hookos-syslog.nix`) writes it to spore's journal under the identifier `hookos`, with the sender's address in `HOOKOS_HOST` and its program in `HOOKOS_PROGRAM`, so a failed action leaves a record: read a node's with `journalctl -t hookos HOOKOS_HOST=<node address>`. With Smee on, Smee receives it instead and writes it to the `tinkerbell` journal.

The firmware verifies each image against `db`. Between runs, `allowPXE` is off on spore. fleetd is its only writer: its `Workflow`s leave `toggleAllowNetboot` off, and each pass sets the flag from whether the device has an unfinished `Workflow`.

## Rules

- Smee is off on spore. [Kea](kea.md) names the iPXE in its offer and iPXE's menu boots HookOS, so any MAC on a node port that PXE-boots reaches the same place, and the boot has no 7080 request to fail. To switch back, set `homelab.tinkerbell.smee.enable` on and `homelab.hookosSyslog.enable` off, and keep `homelab.tinkerbell.smee.dhcp` off while [Kea](kea.md) is on; the `spore-reliability` check then holds Smee to `proxy` mode, which HP's PXE ignores, to TFTP off, which would collide with dnsmasq's, and to one DHCP server on the VLAN.
- Keep namespaces out of `clusters/folly/tinkerbell/`. The API runs no namespace controller, so a deleted namespace stays `Terminating`.
- Keep `Hardware`, `Machine` and `Workflow` objects out of the repo. fleetd owns them, and deletes an object when NetBox stops exporting its device.
- Name a BMC Secret `bmc-<bmc_type>`, the NetBox field's value.
- A rerun of `scripts/tinkerbell-certs.sh` without `--client` mints a new CA and invalidates every certificate.
- Renovate bumps the version in `nix/services/tinkerbell.nix` but not the hash. Copy it from `checksums-embedded.txt`.

## Access

Port 6443 is open on `end0` and `tailscale0`. The `tinkerbell-rbac` unit lets Flux's client certificate, `folly-flux`, write the Template and the Secrets in the namespace and read the rest. fleetd uses the admin certificate.

```sh
ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get hardware,workflows,machines.bmc.tinkerbell.org
```

## Where it lives

- `nix/services/tinkerbell.nix`: the pinned binary, flags, the Smee switch, firewall, unit and Flux's Role
- `nix/services/hookos-syslog.nix`: HookOS's syslog receiver
- `nix/services/fleetd.nix` and `apps/fleetd/`: fleetd, and the `netboot-not-allowed` TFTP links
- `clusters/folly/tinkerbell/`: the `provision` and `provision-image` Templates and the BMC Secrets
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
