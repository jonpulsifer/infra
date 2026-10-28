# Eval-time assertions across the fleet, for couplings that cross hosts or modules.
# They run in `nix flake check` without a builder, and a failure names the offending hosts.
{
  lib,
  pkgs,
  nixosConfigurations,
}:
let
  ok = name: pkgs.runCommand "check-${name}" { } "touch $out";

  require =
    name: cond: message:
    if cond then ok name else throw "check '${name}' failed: ${message}";

  configs = lib.mapAttrs (_: system: system.config) nixosConfigurations;
  spore = configs.spore;
  rackpi5 = configs.rackpi5;

  namesWhere = pred: attrs: lib.attrNames (lib.filterAttrs (_: pred) attrs);
in
{
  # A bare drvPath would make this check build every host's closure, and an x86 runner fails on the
  # first aarch64 build. unsafeDiscardOutputDependency keeps only the .drv, so each host still evaluates.
  fleet-hosts-evaluate = pkgs.runCommand "check-fleet-hosts-evaluate" {
    drvPaths = lib.concatStringsSep "\n" (
      lib.mapAttrsToList (
        _: c: builtins.unsafeDiscardOutputDependency c.system.build.toplevel.drvPath
      ) configs
    );
  } "touch $out";

  # spore's recovery path spans several modules; each entry asserts a coupling a refactor could silently break.
  spore-reliability =
    let
      publisher = spore.systemd.services."spore-native-boot-rackpi5";
      nginx = spore.systemd.services.nginx;
      grow = spore.systemd.services.grow-root-and-partition-storage;
      probe = spore.systemd.services.spore-native-boot-artifact-check;
      tftpRanges = spore.networking.firewall.interfaces.bootstrap.allowedUDPPortRanges;
      hasTftpRange = lib.any (range: range.from == 30000 && range.to == 30099) tftpRanges;
      fetchScript = rackpi5.boot.initrd.systemd.services.fetch-nix-store.script;
      smee = "${spore.systemd.services.tinkerbell.serviceConfig.ExecStart} ";
      failures = lib.filter (failure: failure != null) [
        (
          if lib.hasInfix "/$expected.squashfs" fetchScript then
            null
          else
            "rackpi5 initrd does not fetch the pinned digest URL"
        )
        (
          if lib.hasInfix "stores/rackpi5" publisher.script then
            null
          else
            "publisher does not retain digest-addressed squashfs links"
        )
        (
          if !(lib.elem "spore-native-boot-rackpi5.service" nginx.requires) then
            null
          else
            "nginx hard-requires the native-boot publisher"
        )
        (
          if lib.elem "spore-native-boot-rackpi5.service" nginx.wants then
            null
          else
            "nginx does not want the native-boot publisher"
        )
        (
          if spore.services.dnsmasq.settings."tftp-port-range" == [ "30000,30099" ] then
            null
          else
            "dnsmasq TFTP transfer range is not bounded"
        )
        (if hasTftpRange then null else "bootstrap firewall does not admit the bounded TFTP transfer range")
        (
          if lib.hasInfix "find_data_partition" grow.script && !(lib.hasInfix "mkfs.ext4 -F" grow.script) then
            null
          else
            "first-boot storage does not safely reuse partition state"
        )
        (
          if
            lib.elem "grow-root-and-partition-storage.service" spore.systemd.services.register-nix-paths.requires
          then
            null
          else
            "Nix registration does not require storage setup"
        )
        (
          if
            lib.all (unit: lib.elem unit spore.systemd.services.nfs-data-directories.requiredBy) [
              "nfs-server.service"
              "nfs-mountd.service"
            ]
          then
            null
          else
            "NFS does not require the data mount check"
        )
        (
          if !(spore.services.dnsmasq.settings ? "dhcp-range") then
            null
          else
            "dnsmasq could hand out leases or answer DHCP beside Smee"
        )
        (
          if
            lib.all (flag: lib.hasInfix flag smee) [
              " --dhcp-mode=proxy "
              " --dhcp-bind-interface=bootstrap "
            ]
          then
            null
          else
            "Smee could hand out leases or answer DHCP beyond the bootstrap VLAN"
        )
        (
          if lib.hasInfix " --tftp-server-enabled=false " smee then
            null
          else
            "Smee's TFTP listener would collide with dnsmasq's"
        )
        (
          if
            !(lib.elem 6443 spore.networking.firewall.allowedTCPPorts)
            && !(lib.elem 6443 spore.networking.firewall.interfaces.bootstrap.allowedTCPPorts)
          then
            null
          else
            "the Tinkerbell API is open beyond the Anchor network and the tailnet"
        )
        (
          if lib.hasInfix "spore_native_boot_artifact_available" probe.script then
            null
          else
            "native-boot HTTP probe does not publish its metric"
        )
      ];
    in
    require "spore-reliability" (failures == [ ]) (lib.concatStringsSep "; " failures);

  # Every anchor serves TFTP on the bootstrap VLAN. A DHCP answer from any of them would race UniFi's
  # and Smee's offers, and a boot VIP on another interface would never reach a booting machine. The
  # VLAN holds unenrolled machines, so its chain must refuse ssh, NFS, Garage, the exporters and the
  # Tinkerbell API, which the global allowed ports open on every other interface.
  anchor-boot =
    let
      anchors = lib.filterAttrs (_: c: c.services.keepalived.vrrpInstances ? boot) configs;
      refused = [
        22
        111
        2049
        3900
        3901
        4000
        4001
        4002
        6443
        8081
        9100
        9113
        9253
        9988
      ];
      firewallBroken =
        c:
        let
          fw = c.networking.firewall;
          lines = map lib.trim (lib.splitString "\n" fw.extraCommands);
          rules = tool: lib.filter (lib.hasPrefix "${tool} -w -A nixos-fw-bootstrap ") lines;
          jump =
            tool:
            "${tool} -w -I nixos-fw ${
              toString (lib.length fw.trustedInterfaces + 2)
            } -i bootstrap -j nixos-fw-bootstrap";
          admits =
            port: rule:
            let
              range = builtins.match ".*--dport ([0-9]+):([0-9]+) .*" rule;
            in
            lib.hasInfix "--dport ${toString port} " rule
            || (range != null && lib.toInt (lib.head range) <= port && port <= lib.toInt (lib.last range));
        in
        lib.any
          (
            tool:
            !(lib.elem (jump tool) lines) || lib.last (rules tool) != "${tool} -w -A nixos-fw-bootstrap -j DROP"
          )
          [
            "iptables"
            "ip6tables"
          ]
        || lib.any (rule: lib.any (port: admits port rule) refused) (rules "iptables")
        || lib.any (
          rule: !(lib.hasInfix "-p icmpv6" rule) && rule != "ip6tables -w -A nixos-fw-bootstrap -j DROP"
        ) (rules "ip6tables");
      broken = namesWhere (
        c:
        let
          dnsmasq = c.services.dnsmasq.settings;
        in
        dnsmasq ? "dhcp-range"
        || dnsmasq.port != [ 0 ]
        || c.services.keepalived.vrrpInstances.boot.interface != "bootstrap"
        || !(lib.any (
          range: range.from == 30000 && range.to == 30099
        ) c.networking.firewall.interfaces.bootstrap.allowedUDPPortRanges)
        || firewallBroken c
      ) anchors;
    in
    require "anchor-boot"
      (
        lib.attrNames anchors == [
          "capsule"
          "forge"
          "spore"
        ]
        && broken == [ ]
      )
      "anchors with the boot VIP: ${lib.concatStringsSep ", " (lib.attrNames anchors)}; misconfigured: ${lib.concatStringsSep ", " broken}";

  # Two normal users sharing a uid silently breaks file ownership on the NFS
  # exports every cluster host mounts.
  fleet-unique-uids =
    let
      clashing = namesWhere (
        c:
        let
          uids = lib.mapAttrsToList (_: u: u.uid) (
            lib.filterAttrs (_: u: u.isNormalUser && u.uid != null) c.users.users
          );
        in
        lib.length (lib.unique uids) != lib.length uids
      ) configs;
    in
    require "fleet-unique-uids" (
      clashing == [ ]
    ) "hosts with two normal users sharing a uid: ${lib.concatStringsSep ", " clashing}";
}
