# Reads a cluster topology JSON, which Flux also applies as a ConfigMap. Its data
# stays a flat string map because Flux post-build substitution requires one.
locals {
  data = jsondecode(file("${path.module}/../../../clusters/${var.site}/config/${var.config_map}.json")).data
}
