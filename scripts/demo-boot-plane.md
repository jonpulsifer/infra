# Demo: a node is born from NetBox, through the UDM, Kea and fleetd

Two SSH sessions (the UDM and spore), the NetBox tab, and one spare worker.
Reprovisioning wipes that worker's disk and reschedules its pods: pick `surge`
or `riptide` (worker-g5, TPM 2.0). Not `optiplex` (the control plane), not
`shale` (TPM 1.2, fleetd installs nothing on it), not `swell` (no MAC in
NetBox, so no reservation). Rehearse once beforehand: Kea has answered surge's AMT through the relay,
not yet for a netbooting machine.

Rollback if the node never gets an address: UniFi UI, the Kubernetes
network, turn its DHCP server back on (declared disabled in
`terraform/network/unifi/folly/k8s.tf`); or `atlantis apply` a PR that flips
`dhcp_server.enabled` to true.

## Act 0: what is declared (spore)

```sh
ssh spore.pirate-musical.ts.net
systemctl status kea-dhcp4-server fleetd hookos-syslog --no-pager | grep -E 'Active|●'

# NetBox → fleetd → Kea: one reservation per device with a MAC. boot is null
# until a device has an unfinished Workflow.
sudo jq 'map({name: .hostname, mac: ."hw-address", ip: ."ip-address", boot: ."boot-file-name"})' \
  /var/lib/kea/fleet/reservations.json

# Kea answers on its control socket; nothing acked yet.
kea() { echo "$1" | sudo socat -T 5 - UNIX-CONNECT:/run/kea/kea-dhcp4.socket,ignoreeof | jq .; }
kea '{"command":"status-get"}'
kea '{"command":"statistic-get","arguments":{"name":"pkt4-ack-sent"}}'
sudo cat /var/lib/kea/dhcp4.leases      # the memfile: header only, or the AMT leases

# What a class is: os × workload, one payload kind each.
jq 'map_values({os, workload, payload_kind, template})' \
  "$(systemctl show fleetd -p Environment | tr ' ' '\n' | sed -n 's/^FLEET_CLASSES=//p')"

# The seed every NixOS or Alpine node will read once (keys redacted for the room).
sudo jq 'del(.ssh_authorized_keys)' \
  "$(systemctl show fleetd -p Environment | tr ' ' '\n' | sed -n 's/^FLEET_SEED_INPUTS=//p')"

# Both one-time routes exist; nothing is held, so a GET is 404 and a HEAD is 405.
for p in talos/config seed; do printf '%-13s ' "$p"; curl -sI "https://enroll.lolwtf.ca/$p?uuid=x&code=y" | head -n 1; done
```

## Act 1: the relay (UDM), live

```sh
ssh root@10.13.37.1          # UNIFI_SSH_HOST from your own machine
tcpdump -nei any 'udp port 67 or udp port 68'
```

Narrate: the node broadcasts DISCOVER on the Kubernetes VLAN; the UDM forwards it
unicast to spore's bootstrap address with the VLAN's gateway as the relay
address; Kea's OFFER comes back the same way; the node ACKs. The UDM's own DHCP
for this network is declared and off.

## Act 2: the lifecycle (spore), live

In a second spore window, before you touch NetBox:

```sh
sudo journalctl -f -o cat -u kea-dhcp4-server -u fleetd -t hookos
```

Now, in NetBox (`https://capsule.<tailnet>`), open the worker, set
`desired_action` to `provision`, save. Narrate what scrolls, in order:

1. fleetd's pass: a Workflow `provision-<node>-<unix>` created, Rufio asked to
   PXE-boot the machine once, the reservation rewritten with the boot file and
   Kea reloaded (`config-reload`, result 0). Re-run the reservations `jq`: the
   node's `boot` is now the signed iPXE.
2. Kea: `DHCP4_LEASE_ALLOC` for the node's MAC at its NetBox address,
   `boot-file-name` the signed iPXE, through the relay.
3. HookOS lines (tagged `hookos`): the kernel booting, tink-agent starting,
   attestation against fleetd.
4. fleetd: `install code issued` for the serial, `fleet.render ... rendered`,
   `rendered the worker-g5 Talos config`. The Template wipes the disk and runs
   the installer (console lines arrive through the HookOS syslog too).
5. The node reboots from disk. Talos fetches `/talos/config` by UUID and code:
   `served <node>'s config at <time>; it is dropped`, then the release: the
   device is `active` in NetBox, `attest_consumed_at` set.
6. The next pass: the Workflow succeeded, the reservation's `boot` is null
   again, Kea reloaded. Netboot is off for this MAC; the node boots its disk.

Show the same story in prose: NetBox → the device → Journal. Then:

```sh
kea '{"command":"statistic-get","arguments":{"name":"pkt4-ack-sent"}}'   # > 0
sudo cat /var/lib/kea/dhcp4.leases                                        # the node's lease
curl -s http://127.0.0.1:8446/metrics | grep -E 'fleet_install_(rendered|released)_total|kea_dhcp4'
```

Allow 10 to 15 minutes from the NetBox save to `active`: the installer image is
pulled on every provision.

## Act 3: where the seed comes in (talk, not run)

Same route shape, different class. Point at the `payload_kind` column from Act
0 and at the seed inputs: a `nixos` class device would go through the same
admit and render, and its first boot would fetch `/seed`, read `profile`
(`github:jonpulsifer/infra#<name>`) and switch into it. The image, the
Template that writes it, and the class land next; the plumbing is already on
this host.
