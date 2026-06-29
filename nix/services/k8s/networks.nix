# Per-cluster Kubernetes network parameters.
#
# Sourced from the repo-wide single source of truth: topology/topology.json.
# Do NOT edit addresses here — change topology/topology.json and they flow into
# Nix, Terraform, and the Flux cluster-settings ConfigMaps alike. This file only
# projects the topology onto the attribute shape that nix/services/k8s/default.nix
# consumes (apiServerIP, apiServerHostname, apiServerPort, podCidr, serviceCidr,
# dns, upstreamDns).
let
  topology = builtins.fromJSON (builtins.readFile ../../../topology/topology.json);
  inherit (topology) constants;

  mkCluster = c: {
    apiServerIP = c.apiServerIP;
    apiServerHostname = c.apiServerHostname;
    apiServerPort = constants.apiServerPort;
    podCidr = c.podCidr;
    serviceCidr = c.serviceCidr;
    dns = c.clusterDns;
    upstreamDns = c.routerIp;
  };
in
builtins.mapAttrs (_name: cluster: mkCluster cluster) topology.clusters
