output "attestor" {
  description = "Binary Authorization attestor id (projects/*/attestors/*) the bluenose vessel root's attestor variable takes."
  value       = module.supply_chain.attestor
}

output "supply_chain_manifest_block" {
  description = "The installation manifest's supplyChain block: signer key uri and registry namespace."
  value = {
    signer   = module.supply_chain.signer_uri
    registry = module.supply_chain.registry_namespace
  }
}
