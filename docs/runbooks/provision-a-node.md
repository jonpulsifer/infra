---
title: Provision a node
description: Take a new folly machine from its box to a Ready Talos worker through NetBox, and reprovision, attest again or wipe a node by its desired_action.
---

Use this runbook to add a machine to folly as a Talos worker, and to reinstall or attest a node again. You set the firmware at the machine and declare the device in [NetBox](../platform/netbox.md). The device's `desired_action` then starts the run. [fleet-controller](../apps/fleet-controller.md) makes the Tinkerbell `Workflow`, [talos-attest](../apps/talos-attest.md) attests the TPM and boot chain from HookOS, and [Talos enrollment](../apps/talos-enroll.md) releases the config. [Identity](../platform/identity.md#lifecycle) lists the device statuses.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the firmware settings happen at the machine, and NetBox holds each machine's lifecycle.

## Before you start

- You can sign in to NetBox at `https://capsule.<tailnet>`, and `mise run netbox:export` reaches it.
- You are on the tailnet as a login in `ENROLL_APPROVERS` and `ATTEST_APPROVERS`, and you can read the Discord prompts.
- You can see the machine's screen: at the machine, in MeshCommander, or on riptide's PiKVM.
- The AMT password is in the 1Password item `AMT MEBx credentials`.
- The firmware steps are for the HP EliteDesk 800 G5, the model of riptide.
- `<node>` is the host name, `<serial>` the SMBIOS serial, and `<addr>` the node's address in `K8S_NODE_CIDR` of `clusters/folly/config/cluster-topology.json`.

## Set the firmware

Do this once for each new machine, at the provisioning station. Its port is `provisioning` in `spare_ports` of `terraform/network/unifi/folly/bootstrap.tf`, which puts an unknown MAC on the bootstrap network.

1. Connect the machine to the provisioning station's port and monitor. Power it on and press F10.
2. Write down the serial number and the MAC address from the system information page.

> [!NOTE]
> The firmware's network update fails against HP's servers. An older BIOS can refuse the key enrollment: the 800 G2's 2.37 does, and 2.63 does not.

3. If the BIOS is older than HP's latest, update it from a FAT32 USB stick that the SoftPaq made.
4. Set the date and time to the current UTC time.
5. Turn off legacy support, and turn on UEFI network boot over IPv4.
6. Set the boot order to the NVMe disk first and IPv4 network boot second.
7. Set the power-loss behaviour to power on.
8. Turn on the TPM, and set it to clear at the next boot. The clear keeps the endorsement key (EK).

> [!NOTE]
> With Secure Boot on and no keys, HP reloads its factory keys at the next boot.

9. Turn off Secure Boot, and clear the Secure Boot keys. The firmware is then in Setup Mode.
10. Save, then press F1 to confirm the TPM clear.
11. At boot, press Ctrl+P to open MEBx. Set the AMT password, turn on AMT and network access, and set KVM user consent to none.
12. Boot from IPv4 network boot. Select `enroll` in the `folly netboot` menu within 10 seconds.

    Result: iPXE boots the signed ISO, and its systemd-boot menu appears.

13. Select `Enroll Secure Boot Keys: auto`.

    Result: `Secure Boot keys successfully enrolled`, and the machine reboots.

14. Open the firmware setup, turn on Secure Boot, and power off the machine.

## Declare the device

`NODE_ADDRESSES` names the staged, active and failed nodes and no others, so the device is `staged` before you export it.

1. In NetBox, add a device at the site `folly` with the role `kubernetes-node` and the status `planned`.
2. Set its name, serial and device type, and the fields `talos_class`, `bmc_type`, `install_disk`, `tpm_version`, `amt` and `secure_boot_expected`.
3. Give its first interface the MAC as its primary MAC, and cable that interface to the node's switch port.
4. Set its primary IPv4 to `<addr>`. If `bmc_type` is `redfish`, set its out-of-band IP to the BMC's address.
5. If you know the EK hashes, set `ek_hash` and `ek_hash_ecc`. A pin removes the approval of the first intake.

> [!NOTE]
> If a HookOS run sends a serial that NetBox does not know, talos-attest adds the device at `staged`. It takes the claimed host name or `intake-<serial>`, the MAC and the SMBIOS facts. Complete it with steps 2 to 4.

6. Set the device's status to `staged`.
7. On a branch, export the inventory.

   ```bash
   mise run netbox:export
   ```

   Result: `wrote clusters/folly/inventory/machines.yaml`, with `<node>` at `status: staged`.

8. Add `"<node>": "<addr>"` to `NODE_ADDRESSES` in `clusters/folly/config/cluster-topology.json`.
9. Make sure that the inventory and the addresses agree.

   ```bash
   mise run netbox:check
   ```

   Result: no output.

10. Open a pull request. Comment `atlantis plan -d terraform/network/unifi/folly` and `atlantis plan -d clusters/folly/talos`.

    Result: a RADIUS user, a DHCP reservation and a DNS record for the node. The Talos root adds the node as enrolling and applies nothing to it.

11. Comment `atlantis apply`.
12. Deploy spore from `main`, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes. spore then has a SPIRE alias for the node's LDevID.

## Provision the node

1. Connect the machine to its switch port. Leave it off.
2. Make sure that its Rufio `Machine` is contactable.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get machines.bmc.tinkerbell.org <node> -o jsonpath='{.status.conditions}'
   ```

   Result: a `Contactable` condition with the status `True`.

3. In NetBox, set the device's `desired_action` to `provision`.

   Result: within two minutes, `last_workflow` names `provision-<node>-<unix seconds>`, and `desired_action` is `none`.

## Watch the run

1. Watch the `Workflow`.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get workflows -w
   ```

   Result: `PREPARING`, `PENDING`, then `RUNNING` through `set-clock`, `attest`, `wipe-disk`, `next-boot` and `reboot`, then `SUCCESS`.

2. Watch the console.

   Result: HookOS prints `attest: PASSED` and `wipe:` lines, and reboots. The node netboots the Talos UKI. NetBox shows `attest_verdict` `attested`.

3. Watch the Discord prompt.

   Result: `auto-approved after attestation`, then `<node> fetched its config`. Talos installs and reboots, and NetBox shows `active`.

If the prompt says that the machine is waiting for approval, read the user code on the console and approve it as the node. A `worker-g2` node, which skips the attestation, always waits.

```bash
mise run enroll:approve <code> <node>
```

Result: JSON with `"phase": "approved"` and `"mac_mismatch": false`.

## Approve a first intake

If no pin names the machine's EKs, the console shows `attest: FAILED` with `pending-approval`, and the `Workflow` fails before the wipe. `TalosAttestWaitingForApproval` fires.

> [!CAUTION]
> A waiting claim proves nothing: another machine can send one with this serial. Approve only hashes that you read on the console.

1. Read the EK hashes on the console. The line names them as `rsa:<hash>` and `ecc:<hash>`.
2. Show the claim.

   ```bash
   mise run attest:approve <serial>
   ```

   Result: the anchor that holds the claim, its machine, MAC, UUID and EK hashes, and a question.

3. If the hashes match the console, answer `y`.

   Result: JSON with `approved` and the hashes.

4. Set `desired_action` to `provision` again. The next pass writes the hashes to `ek_hash` and `ek_hash_ecc`.

## Finish a new node

1. Make sure that the node is Ready and that Secure Boot is on.

   ```bash
   kubectl --context folly get node <node>
   talosctl --nodes <addr> get securitystate
   ```

   Result: `Ready`, then `secureBoot: true`.

2. On a branch, run `mise run netbox:export`. Open a pull request with `<node>` at `status: active`.
3. Comment `atlantis plan -d clusters/folly/talos`, then `atlantis apply`. The Talos root then manages the node's config.
4. Make sure that the node's SPIRE agent attests by its LDevID, as [Add a TPM node to SPIRE](add-a-tpm-node-to-spire.md#make-sure-the-agent-serves-svids) describes.

   Result: `spiffe_id="spiffe://lolwtf.ca/spire/agent/tpm_devid/<fingerprint>"`.

## Reprovision, attest again or wipe a node

| `desired_action` | The run | After it |
| --- | --- | --- |
| `provision` | Attests, wipes the system disk, and netboots the Talos UKI | Talos enrollment approves the node with no click |
| `attest` | Attests, and boots the installed disk | The status stays, and the node has a new LDevID |
| `wipe` | Wipes the system disk and netboots, with no attestation | The enrollment waits for a click |

> [!WARNING]
> `provision` and `wipe` erase every partition of the system disk: META, STATE, EPHEMERAL, ETCD and the `data` volume. Velero copies only the volumes of a running pod with the annotation `backup.velero.io/backup-volumes`, so take the backup before the drain.

> [!WARNING]
> optiplex is folly's only control-plane node. Its wipe destroys folly's etcd. Take a snapshot first, as [Restore etcd on Talos](restore-etcd-on-talos.md) describes.

1. If the run wipes the disk, take a Velero backup.

   ```bash
   velero backup create <node>-pre-reprovision --from-schedule daily --wait --kubecontext folly
   velero backup describe <node>-pre-reprovision --details --kubecontext folly
   ```

   Result: a `Pod Volume Backups` list with each volume on the node, in the phase `Completed`.

2. Drain the node. Every run reboots it at least once.

   ```bash
   kubectl --context folly drain <node> --ignore-daemonsets --delete-emptydir-data
   ```

   Result: `node/<node> drained`.

3. In NetBox, set the device's `desired_action`.
4. If the run wipes the disk, delete the node's `Node` object once HookOS runs. Before the wipe, the old kubelet registers it again.

   ```bash
   kubectl --context folly delete node <node>
   ```

5. Watch the run, as [Watch the run](#watch-the-run) describes. An `attest` run boots the installed disk after `attest: PASSED`.
6. Uncordon the node, and restore its volumes, as [Restore a volume](restore-a-volume.md) describes.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `netbox:check` prints `in NODE_ADDRESSES, not exported with an address` | The device is still `planned` | Set it to `staged`, and export again |
| `desired_action` stays set | fleet-controller is down | Read `journalctl -u fleet-controller` on spore |
| No `Workflow`, and the device's journal says that a run waits | The device has no primary MAC or `install_disk` | Set them in NetBox |
| The `Workflow` stays `PREPARING` with `BootJobFailed` | Rufio cannot reach the BMC | Read the `Machine`'s conditions, fix the BMC, and set `desired_action` again |
| The `Workflow` waits, and the node has no BMC | A device with `bmc_type` `none` gets no `Machine` | Boot `IPV4 Network` from the F9 menu |
| HP shows 3F0 Boot Device Not Found after HookOS | The firmware has no IPv4 network boot entry | Boot `IPV4 Network` from the F9 menu |
| The `Workflow` is `FAILED` | An action failed | Read the action's message in the `Workflow`, and the console |
| `attest: FAILED` with `quarantine` | The event log breaks `apps/talos-attest/policy.yaml`, and NetBox shows `failed` | Read the violation, fix the boot chain, and set the status to `staged` |
| `attest: FAILED` with `ek-hash-mismatch` | A pin names another TPM | Compare `mise run attest:pending` with `ek_hash` in NetBox |
| `attest: FAILED` with `open /dev/tpmrm0` or an event log error | HookOS sees no TPM or no securityfs | Read the action's log in the `Workflow`, and `dmesg` on the console |
| `connection refused` to the boot VIP | talos-attest is down on the anchor that holds `BOOT_VIP` | Read `journalctl -u talos-attest` on that anchor |
| The console shows `Talos is already installed to disk but booted from another media` | META is on the disk | Set `desired_action` to `wipe` or `provision` |
| The console shows a certificate error, such as `not yet valid` | The firmware clock is wrong | Set the clock in the firmware, then reboot |
| A prompt appears for a machine that you do not provision | Another host sent a device request | Run `mise run enroll:deny <uuid>` with the UUID from the prompt |
| Approval answers 400 with a list of nodes | The NetBox device has no `talos_class` | Set the device's class |
| Approval answers 409 with a list of classes | `clusters/folly/apps/talos-enroll/class-inputs.json` lacks the class | Run `mise run render-class-inputs`, then merge |
| Approval answers `no anchor knows that code or uuid` | The boot VIP moved, or the code expired | Read the code on the console again |
| `TalosEnrolledNodeNotReady` fires, and the node has a bootstrap address | The node has no RADIUS user, or NetBox shows it `failed` | Make sure that the declaration pull request applied, and read the device's status |
| A `failed` node stays on the Kubernetes network | A Virtual Network Override on its UniFi client comes before RADIUS | Clear the override in the UniFi controller |
| Talos stops at `failed to read pcr signing public key` | Talos booted by kexec | Power-cycle the node |
| iPXE says that `sanboot` failed | The firmware cannot boot the ISO over HTTP | Write `/talos/folly/metal-amd64-secureboot.iso` from spore to a USB stick, and boot it |
| systemd-boot shows no enrollment message | The firmware is not in Setup Mode | Clear the Secure Boot keys again |
| `Selected boot image did not authenticate` | `db` lacks the lab's certificate | Turn off Secure Boot, clear the keys, enroll again, then turn on Secure Boot |
| The screen is black after the enrollment | An option ROM is not signed by a certificate in `db` | Clear the Secure Boot keys, and note the model |

## Related

- [Retire a node](retire-a-node.md)
- [fleet-controller](../apps/fleet-controller.md)
- [Talos enrollment](../apps/talos-enroll.md)
- [talos-attest](../apps/talos-attest.md)
- [Tinkerbell](../platform/nixos/tinkerbell.md)
- [Hardware inventory](../reference/inventory.md)
- [Add a TPM node to SPIRE](add-a-tpm-node-to-spire.md)
