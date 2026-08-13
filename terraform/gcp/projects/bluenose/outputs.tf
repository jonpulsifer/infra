# Roots do not share state with the installation manifest; like
# supply_chain_manifest_block in trusted-builds, this block is what an
# operator copies into the manifest by hand after an apply.
output "vessel_network_block" {
  description = "The installation manifest's bluenose vessel location.network block."
  value = {
    name   = module.network.network_name
    region = module.network.region
  }
}
