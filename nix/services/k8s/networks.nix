# Per-cluster network parameters from clusters/<site>/config/cluster-topology.json; edit addresses
# there. ConfigMap data is flat strings, so the port and the DNS list are parsed here.
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
    nodeCidr = d.K8S_NODE_CIDR;
    lbRange = d.LB_RANGE;
  };
in
{
  folly = mkCluster (configMapData ../../../clusters/folly/config/cluster-topology.json);
  offsite = mkCluster (configMapData ../../../clusters/offsite/config/cluster-topology.json);
}
