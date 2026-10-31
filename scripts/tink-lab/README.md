# tink-lab

`tink-lab.sh` runs folly's provisioning path on this machine, for failure-scenario tests. It runs
the real Tinkerbell v0.25.0, the committed provision Template, the lab's HookOS and agent, and the
Talos installer. Machines are QEMU VMs behind Redfish BMCs. Everything sits in a user and network
namespace of its own. Nothing in the namespace has a route out: no machine and no service in it
can reach spore, NetBox, folly, AMT, Tailscale or the internet.

`scripts/tink-vm/` runs a Template's actions by hand in HookOS. tink-lab runs them through Tink:
real scheduling, real acknowledgements and real Rufio jobs.

## What runs

| Piece | In tink-lab | Differs from the lab |
| --- | --- | --- |
| Tinkerbell | The v0.25.0 embedded binary, amd64, pinned by SHA-256 and checked against the release's `checksums-embedded.txt`. Flags from `nix/services/tinkerbell.nix`. | Namespace addresses. The apiserver listens on loopback (spore: every address behind its firewall) and needs `--advertise-address`, because the namespace has no default route. Smee's proxy DHCP listens on an empty interface; see DHCP. |
| Restarts | A supervisor restarts a Tinkerbell process that fails after 15 s, as the unit's `Restart=on-failure` does. | `TINK_LAB_SPLIT=1` runs etcd, the apiserver, the Tink server, the Tink controller, Smee and Rufio as separate processes of the same binary, so each can be killed alone. spore runs one process. |
| Template | `clusters/folly/tinkerbell/template.yaml` as committed, rendered by the controller. | None. |
| Hardware, Workflow | `provision` and `reconcile` write the objects in fleetd's shapes (`Config.Hardware` and `Config.Workflow` in `apps/fleetd/fleet/objects.go`). They also follow `Reconciler.start`: finished Workflows are deleted, a running one is adopted, and netboot goes on before the Workflow exists. | fleetd does not run: there is no NetBox, no webhook and no reconcile loop. `reconcile` is one pass, run by hand. The HookOS URL and command line are tink-lab's. |
| Rufio | The embedded Rufio, with a Machine for each VM. | The Machine uses the Redfish provider against `bmc.py`, not Intel AMT. One-time PXE sets the VM's BootNext while it is off. |
| DHCP | dnsmasq leases and serves DNS. It hands out the boot option (`talos/lab/ipxe-amd64.efi`), as UniFi does on folly's Kubernetes network, and serves that file over TFTP, as spore does. | Smee proxies on spore's bootstrap VLAN, which no node's port carries. Here it proxies on an empty interface, so the VMs never hear it. OVMF also declines a lease when Smee's proxy answers its REQUEST. |
| iPXE | `ipxe.nix`: the embedded script of `nix/images/ipxe-folly.nix`, chaining Smee's script for the MAC and falling back to the HookOS menu item. | Built locally and unsigned, with tink-lab's addresses and command line. |
| HookOS | The signed UKI from the `talos-folly` release in `HOOKOS_RELEASE`, checked against GitHub's asset digest. | Secure Boot is off, so systemd-stub takes iPXE's command line instead of the signed one. See below. |
| Agent | `tink_agent_image` from `clusters/folly/talos/netboot.json` (tink-agent-autoid), by digest, with `agent/entry.sh` layered in front of its entrypoint. | Attestation is a stand-in. The wrapper writes `/worker/fleet/attested` and a fresh 43-character install code, then runs the lab's `entry.sh`, whose own attestation skips itself. `--attest nocode` or `--attest fail` on `vm create` changes the verdict. |
| Images | The Template's tools image, the agent and each class's installer, from `class-inputs.json`. They are copied from GHCR into a local registry. DNS answers `ghcr.io` with the registry, and HookOS's `insecure_registries=ghcr.io` lets it pull over HTTP. | Same references and digests. The installer is a tag, as in `class-inputs.json`. |
| Install | `ghcr.io/jonpulsifer/talos-installer-folly:v1.14.5` writes the disk and META. Talos boots from the disk, syncs time from `ntp.py` (chrony's part on spore) and asks for its config at the `talos.config` URL. | There is no config server. The config host does not resolve in the namespace, so Talos retries forever. |
| Firmware | OVMF 202602 with a swtpm TPM 2.0, q35, KVM, 2 vCPU and 3 GiB. | No Secure Boot keys are enrolled, so Secure Boot is off. The VM's own PXE and HTTP boot entries exist, and IPv6 PXE is off. |

### The command line and the isolation

HookOS boots with the command line that `cmdline` in `tink-lab.sh` prints. It has
`fleet_attest_url=` empty, and `grpc_authority`, `syslog_host` and `fleet_ntp_server` at the
namespace's boot server, `192.0.2.1` (a documentation range). The agent wrapper refuses to run if
`fleet_attest_url` is set. With Secure Boot on, the stub would use the UKI's signed line, which
names spore and the lab's intake. tink-lab never enrolls keys. If a VM ever booted the signed line,
its requests would still go nowhere:

- The namespace's only routes are the bridge's subnet. `ip_forward` is 0, and no interface leads
  out.
- dnsmasq has no upstream. It answers `ghcr.io` and the machines' own names, and nothing else.

`observe` records `/proc/cmdline` from HookOS, so every run logs the line it used. To check the
isolation:

```sh
tink-lab.sh sh -c 'ip route; cat /proc/sys/net/ipv4/ip_forward; ip -br addr'
```

## Start and stop

Run these from the repository. The first `up` downloads Tinkerbell (150 MB), HookOS (200 MB) and
the images (330 MB). It builds the tools with nix and the iPXE (about 20 s). The downloads go to
`$TINK_LAB_DIR/downloads`, and nothing there is executed except the hash-checked Tinkerbell
binary.

```sh
scripts/tink-lab/tink-lab.sh up           # start, or restart after a reboot of this machine
scripts/tink-lab/tink-lab.sh selftest     # one machine, provisioned end to end, with times
scripts/tink-lab/tink-lab.sh status
scripts/tink-lab/tink-lab.sh down         # stop everything; state stays
scripts/tink-lab/tink-lab.sh reset        # down, and delete the state but the downloads and image cache
```

For a clean run before each test, run `reset`, `up` and `selftest`. `selftest` must print
`"status":0`. It creates the VM `selftest` (or the name you give it) and runs a `provision`
Workflow. It waits for HookOS's shell, the terminal state and the netboot pass. Then it waits for
the installed Talos to ask DNS for its config host. Delete that VM, or make your own:

```sh
tink-lab.sh vm create n1 --disk sys:8G --disk data:4G:virtio --disk fast:4G:nvme --install-disk /dev/vda
tink-lab.sh provision n1             # a Workflow as fleetd makes it; Rufio power-cycles the VM into PXE
tink-lab.sh wait n1 600              # until SUCCESS, FAILED or TIMEOUT; exits 0 on SUCCESS
tink-lab.sh reconcile n1             # fleetd's pass: netboot off once no Workflow runs
tink-lab.sh observe n1
```

Other commands:

- `provision --action wipe|attest|retire` runs the other fleetd actions.
- `--set KEY=VALUE` overrides a `hardwareMap` key. A test that does this must say so.
- `--again` creates a second Workflow while one runs.
- `--no-boot` leaves out the boot mode, as fleetd does for a device without a BMC or a machine that
  waits in HookOS. Rufio does not power-cycle the VM, and the agent of the boot it is in takes the
  run.
- `--template NAME` runs a copy of the Template that `template` applied. A test that does this
  must say so.
- `template NAME [--from FILE] [--timeout ACTION=SECONDS]... [--global SECONDS]` applies a copy of
  the committed Template as NAME, with those action timeouts or that `global_timeout`. `--from`
  copies another Template file instead, such as a proposed fix from another branch. The `template`
  event records the source and a hash of the applied `spec.data`. The committed Template stays as
  it is.
- `slow-installer SECONDS` pushes `ghcr.io/tink-lab/slow-installer:SECONDS`, the class's installer
  behind `slow-installer.sh`. It writes a tick to the install disk every second for SECONDS, 1 MiB
  from its end, and echoes it to the console. Then it runs the real installer. Use it with
  `--set installer_image=...`. A tick after the install action's timeout, or after a wipe, is a disk
  writer that outlived its action. Read the tick from the host with
  `dd if=$TINK_LAB_DIR/vms/NAME/DISK.img bs=512 skip=$((SIZE / 512 - 2048)) count=1`.
- `kubectl` runs against the local API, in namespace `tinkerbell`.
- `vm console NAME TIMEOUT CMD` runs a command on HookOS's root shell on the serial console. For
  hook-docker's Docker, use `nerdctl -n services.linuxkit exec hook-docker docker ...`.
- `vm screen NAME FILE.png` saves the VGA screen. Talos writes to tty0 only.

Logs are in `$TINK_LAB_DIR/logs`:

- `tinkerbell.log`, or one log per part with split. It holds HookOS's syslog, which carries the
  agent's lines.
- `dnsmasq.log` holds DHCP and every DNS query.
- `bmc-NAME.log` holds every Redfish request.
- Each VM's serial console is `vms/NAME/serial.log`.

## Hooks

Each hook prints one JSON object per event and appends it to `$TINK_LAB_DIR/events.jsonl`. Each
object has `time` (UTC, milliseconds) and `event`. With `--when COND`, a hook waits for its
boundary, prints a `boundary` event with the seconds it waited, and then acts. `--delay S` adds a
wait after the boundary. A COND is one of:

- `action=NAME:STATE`: an action of the machine's latest Workflow, with STATE as Tinkerbell writes
  it (`PENDING`, `RUNNING`, `SUCCESS`, `FAILED`, `TIMEOUT`). A hook reads it from a watch on the
  API, so it acts 10-20 ms after the agent's report. `wait` polls it every 0.5 s.
- `workflow=STATE`, or `workflow=FINISHED` for any terminal state.
- `console=TEXT`: serial output written after the hook started, ANSI codes stripped. A hook
  follows the console with inotify and acts within about 10 ms of the line; `wait` polls it every
  0.5 s.
- `log=PROC:TEXT`: a new line in `logs/PROC.log`. For example, `log=dnsmasq:query[A] enroll` is
  Talos's first config fetch, and `log=tinkerbell:` matches what the agent sends to syslog.
- `disk=DISK:STAGE`, for a hook: the machine's disk DISK gains a GPT (`gpt`), a FAT filesystem on
  the partition named `EFI` (`esp`), or Talos's META on the partition named `META` (`meta`). The
  hook reads the disk image every 20 ms. A stage the disk holds when the hook starts counts only
  after it has gone, so `disk=disk0:gpt` on an installed disk waits for the wipe and the new
  install's GPT.

| Hook | Does | Output |
| --- | --- | --- |
| `cut NAME [--when C] [--delay S] [--on-after S]` | SIGKILL of the VM's QEMU and its swtpm: a hard power cut. The next power-on starts a new swtpm from the TPM's saved state. `--on-after` powers it on again through the BMC, with no boot override. | `power-cut` `{vm, when, delay, pid}`, then `power` |
| `power NAME on\|off\|soft\|cycle\|status` | Redfish `ComputerSystem.Reset` (On, ForceOff, GracefulShutdown, PowerCycle) on the VM's BMC, the call Rufio makes. | `power` `{vm, reset}`; `status` prints `{vm, power, boot}` |
| `agent-net NAME cut\|restore [--when C] [--reject]` | nft drops (or with `--reject`, resets) the VM's TCP to the Tink server's port 42113 only, both ways. DHCP, HTTP and the registry still work. | `agent-net` `{vm, action, verdict}` |
| `kill PROC [--signal SIG] [--when C]` | Signals a process (default KILL). For `--when`, set `TINK_LAB_VM` to the machine to watch. Tinkerbell processes restart after 15 s, unless they die of TERM, INT, HUP or PIPE. | `kill` `{proc, signal, pid}` |
| `stop PROC`, `start PROC` | Stops a process for good, or starts it. PROC is `tinkerbell` (or, with split, `etcd`, `apiserver`, `tink-server`, `tink-controller`, `smee`, `rufio`), `dnsmasq`, `registry`, `http`, `ntp` or `bmc-NAME`. `down` and `up` stand in for losing spore. | `stop`, `start` `{proc, pid}` |
| `disk NAME sentinel` | Rewrites each disk's sentinels: a GPT with one partition named `sentinel-VM-DISK`, and a record at 1 MiB, 17 MiB, the middle, and 2 MiB from the end. `vm create` writes them too. | `disk` |
| `disk NAME shuffle` | Reverses the order in which the disks take PCI slots and SATA ports, from the next power-on. Virtio names follow slot order, so `/dev/vda` becomes another disk. | `disk` `{order}` |
| `disk NAME usb-attach DISK SIZE` | A USB disk with sentinels, hotplugged when the VM runs and kept for later boots. | `disk` `{disk, serial, hotplug}` |
| `disk NAME detach DISK`, `attach DISK` | Takes a disk out of the VM, or puts it back, from the next power-on; a USB disk also unplugs or plugs in at once. The image stays, and `observe` still reads its sentinels. | `disk` `{disk, attached}` |
| `efi NAME show\|next ENTRY\|order A,B,...` | Reads the VM's EFI boot variables from its OVMF store. A write needs the VM off. `next Pxe` or `next Hdd` picks the first such entry in BootOrder. | `efi` `{result}` |
| `registry delete IMAGE`, `restore IMAGE` | Deletes a lab image's manifest (IMAGE is any part of its reference, such as `talos-installer`), so a pull fails with "manifest unknown". `restore` pushes it back from the cache. | `registry` `{action, image, digest}` |
| `registry deny [--drop]`, `allow` | The VMs' connections to the registry are reset, or with `--drop` hang. | `registry` `{action, verdict}` |
| `registry throttle KBPS` | The registry's packets to the VMs over KBPS kilobytes a second are dropped, so a pull crawls instead of failing. `allow` lifts it. | `registry` `{action, kbytes_per_second}` |
| `hookos-docker NAME ARGS...` | Runs hook-docker's `docker ARGS...` on HookOS through the serial console, such as `restart tink-worker` to restart the agent. hook-bootkit starts `tink-worker` with restart policy `no`, so nothing else restarts it in one boot. A restart re-runs the stand-in attestation, which writes a new install code. | `hookos-docker` `{vm, args, status, output}` |
| `observe NAME [--no-console]` | A snapshot. See below. | `observe` |

`observe` records:

- `workflows`: each Workflow's state, current action, `hardwareMap`, conditions, and each action's
  state, message, start, stop and duration.
- `hardware`: `allowPXE`, `allowWorkflow` and the declared disk.
- `rufio_jobs`: each job's conditions.
- `disks`: for each disk, the bus, serial, slot, `attached`, every sentinel, `intact`, and the GPT
  partitions. Each partition has its filesystem signature (`fs`: `vfat`, `talos-meta`, `ext4`,
  `xfs` or null), the MiB that hold anything (`used_mib`), and, on `META`, the keys of both copies.
  Key `0x0b`, the install code, shows its first 4 characters only.
- `efi`: BootOrder, BootNext, and each `Boot####` entry with its description and kind (`disk`,
  `pxe-ipv4`, `http`, `firmware`).
- `hookos`, when HookOS's shell answers within 20 s: `/proc/cmdline`, the `/worker/fleet` listing
  with the first 4 characters of the boot's install code (`code=`),
  hook-docker's containers (`docker ps -a`), which show a surviving installer or a
  `provision-reboot` container, the kernel's disks (`blocks`: name, removable, sectors, serial,
  WWID and sysfs path, which shows the bus), and the `/dev/disk/by-id` names (`by_id`). `blocks`
  maps each kernel name to a disk's serial in that boot.
- `tpm_state`: a hash of the swtpm state.

## The five observations for each run

1. **Workflow state.** Run `observe` and `wait`. Record the Workflow's terminal state and each
   action's state and times. Record them separately from what ran: a `SUCCESS` says nothing about
   the disk.
2. **Disk and boot state.** From `observe`, record the `disks` (which sentinels changed, which
   partitions exist), `efi` (BootOrder, BootNext and the Talos entry), and what the VM booted. The
   console or `vm screen` shows it, and so does `log=dnsmasq:query[A] <config host>` from the VM's
   address.
3. **Identity state.** Record the install code and the attested marker in `/worker/fleet` (from
   `observe`'s `hookos.fleet`), `tpm_state`, and the code Talos read from META (its screen shows it
   in the config URL). LDevIDs and SPIRE do not exist here; see the gaps.
4. **Recovery time.** Use the `time` fields in `events.jsonl`: from the injection to the terminal
   state, or to the next good boot.
5. **Manual interventions.** Record every command you ran after the injection, beyond the
   scenario's own. `events.jsonl` has the ones that went through `tink-lab.sh`.

## Times

These were measured on the WSL box, with the downloads and images cached.

| Step | Time |
| --- | --- |
| `up` after `reset` | 12.5 s |
| Workflow created to Rufio's netboot job complete | 1 s |
| Power-on to HookOS's shell (PXE, iPXE, the 200 MB UKI over HTTP) | 37-39 s |
| HookOS's shell to the first action | 0-2 s |
| wipe-disk, install, next-boot, reboot | 1.6 s, 2.2-2.7 s, 0.2-0.5 s, 0.2-1.3 s |
| Workflow created to `SUCCESS` | 46-51 s |
| `SUCCESS` to Talos asking DNS for its config | 29 s |
| `selftest`, start to finish | 75 s |
| `kill tinkerbell` to the API answering again | 17 s |

Once, on a new VM's first boot, the agent's image pull started 2 min 15 s after HookOS's shell, and
the Workflow took 179 s. The cause is unknown.

## Known gaps

The test numbers are those in the test plan.

- **No fleetd, NetBox, SPIRE or attestation.** Tests 4, 6 and 10 can exercise only Tinkerbell's
  side:
  - Duplicate webhooks and fleetd's adopt-or-create cannot run. `provision --again` makes a second
    Workflow directly.
  - A fleetd restart cannot be tested.
  - The stand-in issues no LDevID and no SPIRE registration, so the credential questions of test 10
    need the real attest path.
- **No config server.** The installed Talos reaches its first config fetch and stops there. Test 8
  needs a stand-in for fleetd's `/talos/config`, and a name and certificate the installed Talos
  trusts.
- **Secure Boot is off.** No PCR 7 policy, no signed command line and no db or dbx is exercised.
  Test 9 covers BootNext, BootOrder, stale entries and PXE first (`efi`), but not refused images or
  full variable stores.
- **OVMF is not HP firmware.**
  - OVMF puts a disk entry before PXE in a fresh BootOrder, and it adds `UEFI Misc Device` entries
    for blank disks.
  - The Talos installer's `Talos Linux UKI` entry was created but not added to BootOrder. The disk
    booted through `UEFI Misc Device`.
  - In HookOS, efivarfs is mounted read-only. next-boot logged `BootNext refused (Could not set
    BootNext: Read-only file system)` on every run. Check this on hardware before treating it as a
    finding (test 9).
- **Power cuts are SIGKILL of QEMU.** Writes that QEMU had already passed to the host survive, as
  a disk's own cache might not. Raw disk images, no cache mode set. Writes still in the guest's
  page cache are lost, as on hardware. In four cuts during the Talos installer, the disk held a
  GPT with no filesystem, an empty formatted ESP, or the whole ESP and META, never part of the UKI.
- **Some boots wait minutes for DHCP.** After some power cuts, the next boot's first DHCP
  exchange (iPXE's or Talos's) reached dnsmasq only 110-175 s after power-on, while OVMF's PXE DHCP
  was answered at once. The cause is not found. Time recovery from the Workflow's events and the
  console, not from the first DNS query.
- **Action boundaries come from the API.** An action finishes in HookOS before the API shows it.
  The window between the two is the agent's report. For test 2, cut the agent's network while the
  action runs (`--when action=install:RUNNING`), so it finishes and cannot report. next-boot and
  reboot finish about 150 ms after they report `RUNNING`; the watch beats that, so check that the
  agent's `executed action` line comes after the `agent-net` event.
- **Timeouts are the Template's.** The installer finishes in about 2 s. For test 3, make the
  installer slow (`slow-installer`) or its pull slow (`registry throttle` once the tools image is
  pulled, as during wipe-disk), and run a copy of the Template with a shorter timeout (`template`).
  Each varies the inputs, and the finding must say so.
- **One flat network.** The VMs, the boot server and the registry share one bridge. The lab routes
  between the Kubernetes network and spore's bootstrap VLAN.
- **HookOS's image cache lives in RAM for one boot.** To take an image out of it mid-run (test 7),
  run `docker rmi` through `vm console`.
- **Memory.** Each VM takes 3 GiB, so this machine runs about three at once. Test 4's concurrency
  runs need more memory, or smaller VMs (`TINK_LAB_VM_MEM`).

## Files

| File | What it is |
| --- | --- |
| `tink-lab.sh` | The entry point and every hook. |
| `bmc.py` | The Redfish BMC for one VM, which owns its QEMU process. |
| `efivars.py` | Reads and writes BootNext and BootOrder in an OVMF variable store, through `virt-fw-vars`. |
| `ntp.py` | An SNTP server on the boot server's address. |
| `hookos-observe.py` | Parses what `observe` reads from HookOS's console. |
| `diskstate.py` | Reads a disk image's partitions, filesystems and META keys for `observe`, and watches for `disk=` boundaries. |
| `agent/entry.sh` | The stand-in attestation, layered on the lab's agent image. |
| `slow-installer.sh` | The slow installer's entrypoint, in front of the class's installer. |
| `ipxe.nix` | The netboot iPXE with tink-lab's addresses. |
