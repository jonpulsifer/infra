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
          if spore.services.dnsmasq.settings."tftp-single-port" or [ ] == [ true ] then
            null
          else
            "dnsmasq TFTP transfers leave port 69"
        )
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

  # spore alone serves TFTP on the bootstrap VLAN. A DHCP answer from it would race UniFi's and
  # Smee's offers. The VLAN holds unenrolled machines, so its chain must refuse ssh, NFS, Garage,
  # the exporters and the Tinkerbell API, which the global allowed ports open on every other
  # interface.
  boot-plane =
    let
      anchors = lib.filterAttrs (_: c: c.networking.vlans ? bootstrap) configs;
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
        || dnsmasq."tftp-single-port" or [ ] != [ true ]
        || firewallBroken c
      ) anchors;
    in
    require "boot-plane"
      (lib.attrNames anchors == [ "spore" ] && broken == [ ])
      "hosts on the bootstrap VLAN: ${lib.concatStringsSep ", " (lib.attrNames anchors)}; misconfigured: ${lib.concatStringsSep ", " broken}";

  # spore's SPIRE server runs the EK attestor, the tpm_devid attestor, or both, by two switches. The
  # LDevID aliases are fleetd's, so spore declares none. An agent matches a node entry only when it
  # has every selector, so a node with two attestors needs two aliases, which a key tells apart.
  spire-devid =
    let
      extend = module: (nixosConfigurations.spore.extendModules { modules = [ module ]; }).config;
      testChain = pkgs.writeText "test-devid-chain.pem" "";
      # spore runs both attestors today; the EK-only shape is derived.
      ekOnly = extend { homelab.spire.devid.enable = lib.mkForce false; };
      both = extend {
        homelab.spire.devid = {
          enable = lib.mkForce true;
          caChains = [ testChain ];
        };
      };
      devidOnly = extend {
        homelab.spire = {
          ekHashes = lib.mkForce [ ];
          devid = {
            enable = lib.mkForce true;
            caChains = [ testChain ];
          };
        };
      };
      keyed = extend {
        homelab.spire.entries = lib.mkForce [
          {
            spiffeID = "spiffe://lolwtf.ca/node/riptide";
            selectors = [ "tpm:pub_hash:test" ];
          }
          {
            spiffeID = "spiffe://lolwtf.ca/node/riptide";
            key = "tpm_devid";
            selectors = [ "tpm_devid:subject:cn:riptide" ];
          }
        ];
      };
      attestors =
        c:
        lib.attrNames (
          lib.filterAttrs (_: v: v != null) c.services.spire.server.settings.plugins.NodeAttestor
        );
      aliases =
        c: name: lib.filter (e: e.spiffeID == "spiffe://lolwtf.ca/node/${name}") c.homelab.spire.entries;
      sync = c: c.systemd.services.spire-server-entries.script;
      devidData = both.services.spire.server.settings.plugins.NodeAttestor.tpm_devid.plugin_data;
      failures = lib.filter (failure: failure != null) [
        (if attestors ekOnly == [ "tpm" ] then null else "devid.enable off still runs tpm_devid")
        (
          if
            attestors both == [
              "tpm"
              "tpm_devid"
            ]
          then
            null
          else
            "both switches on does not run both attestors: ${toString (attestors both)}"
        )
        (
          if attestors devidOnly == [ "tpm_devid" ] && !(devidOnly.environment.etc ? "spire/tpm-hashes") then
            null
          else
            "an empty ekHashes leaves the EK attestor or its allow list"
        )
        (
          if
            lib.hasInfix "spire-devid-ca.pem" devidData.devid_ca_path
            && lib.hasInfix "spire-endorsement-ca.pem" devidData.endorsement_ca_path
          then
            null
          else
            "tpm_devid does not read the DevID and endorsement CA files"
        )
        (
          if
            lib.all
              (
                name:
                let
                  selectors = c: map (e: e.selectors) (aliases c name);
                in
                lib.length (selectors ekOnly) == 1
                && lib.hasPrefix "tpm:pub_hash:" (lib.head (lib.head (selectors ekOnly)))
                && selectors both == selectors ekOnly
              )
              [
                "optiplex"
                "riptide"
              ]
          then
            null
          else
            "a node in ekHashes does not have exactly one alias, by EK hash"
        )
        # fleetd's spire-nodes.json holds every LDevID alias, so the applier withdraws it.
        (
          if lib.any (e: lib.any (lib.hasPrefix "tpm_devid:") e.selectors) both.homelab.spire.entries then
            "spore declares a tpm_devid alias, which fleetd's file holds"
          else
            null
        )
        (
          let
            lines = lib.splitString "\n" (lib.replaceStrings [ "'" ] [ "" ] (sync keyed));
            ids = map (line: lib.elemAt (lib.splitString " " line) 1) (
              lib.filter (
                line: lib.hasPrefix "apply " line && lib.hasInfix " -spiffeID spiffe://lolwtf.ca/node/riptide " line
              ) lines
            );
          in
          if lib.length ids == 2 && lib.unique ids == ids then
            null
          else
            "the entry sync does not give two keyed aliases of one node distinct IDs"
        )
      ];
    in
    require "spire-devid" (failures == [ ]) (lib.concatStringsSep "; " failures);

  # nix/lib/inventory.nix reads the nodes file without a YAML parser, so it must take the file's
  # shape exactly and throw on anything else rather than drop or merge a machine.
  inventory-reader =
    let
      read =
        text:
        import ./inventory.nix {
          inherit lib;
          path = builtins.toFile "nodes.yaml" text;
        };
      reads = text: (builtins.tryEval (builtins.deepSeq (read text) true)).success;
      models = "models:\n  m:\n    disk: /dev/sda\n    tpm: \"2.0\"\n    name: M\n";
      sample = read ''
        # A comment.
        models:
          g5: # a model
            name: HP EliteDesk 800 G5 Desktop Mini
            disk: /dev/nvme0n1
            tpm: "2.0"  # quoted, then a comment
            amt: true
            secure_boot: true
        nodes:
          riptide: # g5
            model: g5
            serial: MXL0172Q6L
            class: worker-g5          # talos_class
            nested:
              type: amt
            address: 10.0.0.12
          "quoted":
            model: g5
            tpm: '1.2'
            amt: false
        other:
          ignored: 1
      '';
      refused = {
        "a tab-indented key" = models + "nodes:\n  a:\n\tmodel: m\n";
        "a key three spaces in" = models + "nodes:\n  a:\n   model: m\n";
        "a flow sequence" = models + "nodes:\n  a:\n    model: m\n    tags: [a, b]\n";
        "a deep line under a scalar" = models + "nodes:\n  a:\n    model: m\n      y: z\n";
        "a repeated node" = models + "nodes:\n  a:\n    model: m\n  a:\n    model: m\n";
        "a repeated key" = models + "nodes:\n  a:\n    model: m\n    model: m\n";
        "a key before any node" = models + "nodes:\n    model: m\n";
        "an unknown model" = models + "nodes:\n  a:\n    model: other\n";
        "no models key" = "nodes:\n  a:\n    model: m\n";
        "no nodes key" = models;
      };
      failures =
        lib.optional (
          sample != {
            riptide = {
              model = "g5";
              serial = "MXL0172Q6L";
              class = "worker-g5";
              address = "10.0.0.12";
              disk = "/dev/nvme0n1";
              tpm = "2.0";
              amt = true;
              secure_boot = true;
            };
            quoted = {
              model = "g5";
              disk = "/dev/nvme0n1";
              tpm = "1.2";
              amt = false;
              secure_boot = true;
            };
          }
        ) "the sample reads as ${builtins.toJSON sample}"
        ++ lib.optional (
          read (lib.replaceStrings [ "\n" ] [ "\r\n" ] (models + "nodes:\n  a:\n    model: m\n")) != {
            a = {
              model = "m";
              disk = "/dev/sda";
              tpm = "2.0";
            };
          }
        ) "CRLF line ends change the result"
        ++ lib.optional (read (models + "nodes: {}\n") != { }) "an empty fleet does not read as no nodes"
        ++ lib.mapAttrsToList (what: _: "${what} is accepted") (lib.filterAttrs (_: reads) refused);
    in
    require "inventory-reader" (failures == [ ]) (lib.concatStringsSep "; " failures);

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
