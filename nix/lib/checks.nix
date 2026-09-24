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
  k8sHosts = lib.filterAttrs (_: c: c.services.k8s.enable or false) configs;
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

  # The cluster CA reads Terraform PKI outputs by path, and path interpolation is lazy: a missing
  # cert fails nothing until a host enables clusterCa.
  k8s-cluster-ca-certs =
    let
      missing = lib.unique (
        lib.concatMap (
          c:
          let
            net = c.services.k8s.network;
          in
          lib.filter (f: !builtins.pathExists (../../terraform/pki/certs + "/${f}")) [
            "${net}-ca.pem"
            "${net}-ca-bundle.pem"
            "${net}-ca-chain.pem"
            "${net}-sa-signer.pem"
          ]
        ) (lib.attrValues (lib.filterAttrs (_: c: c.services.k8s.clusterCa.enable) k8sHosts))
      );
    in
    require "k8s-cluster-ca-certs" (missing == [ ])
      "services.k8s.clusterCa is enabled for a cluster whose Terraform PKI outputs are missing from terraform/pki/certs: ${lib.concatStringsSep ", " missing}";

  # A control-plane node signs service-account tokens with a key that only sops
  # delivers; without the secret the apiserver unit has nothing to read.
  k8s-control-plane-sa-signing-key =
    let
      missing = namesWhere (c: !((c.sops.secrets or { }) ? "k8s-sa-signing-key")) (
        lib.filterAttrs (_: c: c.services.k8s.role == "control-plane") k8sHosts
      );
    in
    require "k8s-control-plane-sa-signing-key" (missing == [ ])
      "control-plane nodes without sops.secrets.\"k8s-sa-signing-key\": ${lib.concatStringsSep ", " missing}";

  # spore's recovery path spans several modules; each entry asserts a coupling a refactor could silently break.
  spore-reliability =
    let
      publisher = spore.systemd.services."spore-native-boot-rackpi5";
      nginx = spore.systemd.services.nginx;
      grow = spore.systemd.services.grow-root-and-partition-storage;
      probe = spore.systemd.services.spore-native-boot-artifact-check;
      tftpRanges = spore.networking.firewall.allowedUDPPortRanges;
      hasTftpRange = lib.any (range: range.from == 30000 && range.to == 30099) tftpRanges;
      fetchScript = rackpi5.boot.initrd.systemd.services.fetch-nix-store.script;
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
        (if hasTftpRange then null else "firewall does not admit the bounded TFTP transfer range")
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
            "NFS does not require post-mount directory setup"
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
