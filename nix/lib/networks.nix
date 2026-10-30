# folly's network parameters from clusters/folly/config/cluster-topology.json; edit addresses there.
# apiServerCA is folly's pinned cluster CA.
let
  d = (builtins.fromJSON (builtins.readFile ../../clusters/folly/config/cluster-topology.json)).data;
in
{
  folly = {
    podCidr = d.CILIUM_POD_CIDR;
    nodeCidr = d.K8S_NODE_CIDR;
    lbRange = d.LB_RANGE;
    apiServer = "https://${d.API_SERVER_HOSTNAME}:${d.API_SERVER_PORT}";
    apiServerCA = ../../clusters/folly/config/kubernetes-ca.pem;
  };
}
