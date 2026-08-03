# Network single source of truth. The selected JSON file is both a Flux
# ConfigMap and the shared facts consumed by OpenTofu. Keys remain a flat
# string-to-string map so Flux post-build substitution can consume them.
locals {
  data = jsondecode(file("${path.module}/../../../clusters/${var.site}/config/${var.config_map}.json")).data
}
