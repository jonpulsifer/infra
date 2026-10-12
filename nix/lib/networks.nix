# folly's network parameters from clusters/folly/config/cluster-topology.json; edit addresses there.
# The NFS exports on spore admit these ranges.
let
  d = (builtins.fromJSON (builtins.readFile ../../clusters/folly/config/cluster-topology.json)).data;
in
{
  folly = {
    podCidr = d.CILIUM_POD_CIDR;
    nodeCidr = d.K8S_NODE_CIDR;
    lbRange = d.LB_RANGE;
  };
}
