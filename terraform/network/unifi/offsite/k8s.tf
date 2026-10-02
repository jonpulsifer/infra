locals {
  clients = yamldecode(file("./clients.yaml"))

  # Hostname to address for every node, from the topology ConfigMap. Each node
  # also needs its MAC under `k8s` in clients.yaml. Their A records are in
  # terraform/network/cloudflare/lolwtf.ca.tf, which reads the same key.
  node_addresses = jsondecode(local.topology.NODE_ADDRESSES)
}

# A node keeps its address across a reinstall because the reservation is on
# its MAC. Reserved inside the DHCP pool; the controller excludes reserved
# addresses from it. A node in NODE_ADDRESSES with no `k8s` entry in
# clients.yaml fails the plan on the index below.
resource "unifi_client" "k8s_nodes" {
  for_each = local.node_addresses

  mac        = local.clients.k8s[each.key].mac
  name       = each.key
  fixed_ip   = each.value
  network_id = unifi_network.k8s.id
  note       = "terraform managed - offsite Kubernetes node"

  # The controller already knows these MACs.
  allow_existing         = true
  skip_forget_on_destroy = true
}
