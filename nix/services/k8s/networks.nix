# Per-cluster Kubernetes network parameters.
#
# Single source of truth: the per-cluster `cluster-topology` ConfigMap manifests
# under clusters/<site>/config/cluster-topology.json. Those JSON files ARE the
# Flux ConfigMaps (applied as-is) and double as the structured facts read here
# and by the Terraform network roots — no generator, one file per cluster.
#
# Do NOT edit addresses here: change the cluster-topology.json files and the
# values flow into Nix, Terraform, and Flux alike. This module only projects the
# flat ConfigMap data onto the typed attribute shape nix/services/k8s/default.nix
# consumes (apiServerIP, apiServerHostname, apiServerPort, podCidr, serviceCidr,
# dns, upstreamDns). ConfigMap data is string→string, so the port is parsed to an
# int and the comma-separated DNS list is split back into a list.
{ lib }:
let
  configMapData = path: (builtins.fromJSON (builtins.readFile path)).data;

  mkCluster = d: {
    apiServerIP = d.API_SERVER_IP;
    apiServerHostname = d.API_SERVER_HOSTNAME;
    apiServerPort = lib.toInt d.API_SERVER_PORT;
    podCidr = d.CILIUM_POD_CIDR;
    serviceCidr = d.SERVICE_CIDR;
    dns = lib.splitString "," d.CLUSTER_DNS;
    upstreamDns = d.ROUTER_IP;
    # NFS export and firewall require the node CIDR and the LB VIP pool.
    nodeCidr = d.K8S_NODE_CIDR;
    lbRange = d.LB_RANGE;
  };
in
{
  folly = mkCluster (configMapData ../../../clusters/folly/config/cluster-topology.json);
  offsite = mkCluster (configMapData ../../../clusters/offsite/config/cluster-topology.json);
}
