# Network single source of truth. Edit /topology/topology.json, not the values
# that reference local.topology here. See topology/README.md.
locals {
  topology = jsondecode(file("${path.module}/../../topology/topology.json"))
}
