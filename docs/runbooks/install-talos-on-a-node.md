---
title: Install Talos on a node
description: Boot a running NixOS node into the Talos installer with kexec, check it in maintenance mode, and check its volumes after the install.
---

Use this runbook to boot a NixOS node into the Talos Linux installer without a USB drive or a site visit. kexec loads the Image Factory kernel for the cluster's schematic from the running system. Talos then waits in maintenance mode, with the disk untouched, until the `clusters/<site>/talos/` root applies its machine config and installs it. [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md) says when to run it for each node.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the node runs no Talos API until it boots the installer.

## Before you start

- You need SSH access to the node as `jawn`, with `sudo`, and `talosctl` on your machine.
- You need a path to the node's port 50000 that does not depend on the node's own cluster.
- Get the schematic ID from `tofu -chdir=clusters/<site>/talos output -raw schematic_id`, and the version from `talos_version` in `clusters/<site>/talos/talos.tf`.

`<node>` is the host name, and `<addr>` is its entry in `NODE_ADDRESSES` in `clusters/<site>/config/cluster-topology.json`.

## Load the installer

1. Sign in to the node.

   ```bash
   ssh <node>.lolwtf.ca
   ```

2. Download the kernel, the initramfs and the kernel command line for the schematic.

   ```bash
   S=<schematic> V=<version>
   sudo mkdir -p /var/tmp/talos && cd /var/tmp/talos
   sudo curl -fsSLo kernel-amd64 "https://factory.talos.dev/image/$S/$V/kernel-amd64"
   sudo curl -fsSLo initramfs-amd64.xz "https://factory.talos.dev/image/$S/$V/initramfs-amd64.xz"
   sudo curl -fsSLo cmdline "https://factory.talos.dev/image/$S/$V/cmdline-metal-amd64"
   ```

3. Make sure that the command line names the platform.

   ```bash
   grep -o 'talos.platform=metal' cmdline
   ```

   Result: `talos.platform=metal`.

4. Load the installer, and make sure that the kernel holds it.

   ```bash
   sudo kexec -l kernel-amd64 --initrd=initramfs-amd64.xz --command-line="$(cat cmdline)"
   cat /sys/kernel/kexec_loaded
   ```

   Result: `1`.

> [!CAUTION]
> The next step stops every pod on the node. Maintenance mode cannot reboot. Only a machine config or a power cycle takes the node out of it.

5. Boot the installer.

   ```bash
   sudo systemctl kexec
   ```

## Check maintenance mode

1. From your machine, make sure that Talos answers.

   ```bash
   talosctl version --insecure --nodes <addr>
   ```

   Result: A `Server` block with the Talos version.

2. Make sure that the schematic's extensions loaded.

   ```bash
   talosctl get extensions --insecure --nodes <addr>
   ```

   Result: `gvisor`, `i915`, `intel-ucode`, `kata-containers`, `realtek-firmware`, and a row named for the schematic ID.

3. Read the disks and the links.

   ```bash
   talosctl get disks --insecure --nodes <addr>
   talosctl get links --insecure --nodes <addr>
   ```

   Result: The install disk named by `install` for the node in `talos.tf`, and an `eno` or `enp` link up. Cilium's `devices` matches those names.

4. Read the GPU's kernel log.

   ```bash
   talosctl dmesg --insecure --nodes <addr> | grep -iE 'i915|wedged|GuC'
   ```

   Result: i915 lines with no `wedged`.

> [!NOTE]
> A GPU that was never reset can wedge after kexec. Whether Talos boots cleanly with `module_blacklist=i915` on the command line is not known.

## Check the volumes after the install

The `clusters/<site>/talos/` apply installs Talos and reboots the node. Then do these checks before a pod lands on the node. A pod that lands first writes to `EPHEMERAL`, and the error is silent.

1. Read the volumes.

   ```bash
   talosctl --context <site> -n <addr> get volumestatus
   ```

   Result: `EPHEMERAL`, `u-data` and, on the control plane, `ETCD`, each in the phase `ready`.

2. Make sure that the `data` volume is mounted.

   ```bash
   talosctl --context <site> -n <addr> get mountstatus
   ```

   Result: `/var/mnt/data` with the filesystem `xfs`.

3. Make sure that the node runs the root's installer.

   ```bash
   talosctl --context <site> -n <addr> version --short
   ```

   Result: The `talos_version` of the root.

4. If the node is riptide, power-cycle it once before you use the GPU.

   ```bash
   talosctl --context <site> -n <addr> reboot --mode powercycle
   ```

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The node is back on NixOS about 25 seconds after the kexec. | The command line lacks `talos.platform=metal`. | Do the procedure again with the factory's `cmdline-metal-amd64`. |
| `systemctl kexec` reboots into NixOS. | Nothing was loaded, so NixOS loaded itself. | Do step 4 again, and check `kexec_loaded`. |
| Talos does not answer on `<addr>`. | The node hangs, or DHCP gave another address. | Find the node's lease by MAC, as [Inspect the UniFi network](inspect-the-unifi-network.md) describes. If the node hangs, power-cycle it. The disk is untouched. |
| A volume is missing or not `ready`. | The disk layout did not provision. | Boot the node from `https://factory.talos.dev/image/<schematic>/<version>/metal-amd64.iso` on a USB drive, then apply the root again. |

## Related

- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
- [Verify a Talos cluster](verify-a-talos-cluster.md)
- [Issue a talosconfig](issue-a-talosconfig.md)
