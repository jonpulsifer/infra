# Eval-time assertions over the whole fleet: this is where a cross-host
# coupling gets stated instead of left to convention.
#
# These run inside `nix flake check` in seconds and need no builder and no
# hardware. A failing one throws at evaluation with the offending hosts named.
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

  namesWhere = pred: attrs: lib.attrNames (lib.filterAttrs (_: pred) attrs);
in
{
  # Every configuration in the registry still evaluates. Naming it as a check
  # makes it something you can run on its own, not just a side effect of
  # `nix flake check` walking nixosConfigurations.
  #
  # `unsafeDiscardOutputDependency` is what keeps this a *check* and not a
  # fleet build. A bare `drvPath` carries a string context that means "build
  # this derivation and its entire closure", so naming every host's toplevel
  # here would make the check depend on ~15k derivations across both
  # architectures — an x86 runner then fails on the first aarch64-only build.
  # Discarding that context keeps the dependency on the `.drv` file, which
  # still forces each host to instantiate: exactly the evaluation this asserts.
  fleet-hosts-evaluate = pkgs.runCommand "check-fleet-hosts-evaluate" {
    drvPaths = lib.concatStringsSep "\n" (
      lib.mapAttrsToList (
        _: c: builtins.unsafeDiscardOutputDependency c.system.build.toplevel.drvPath
      ) configs
    );
  } "touch $out";

  # The repo-managed cluster CA consumes Terraform PKI outputs by path. Nix
  # path interpolation is lazy, so a missing cert for a cluster that has not
  # turned clusterCa on yet fails nothing until the day it does.
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
