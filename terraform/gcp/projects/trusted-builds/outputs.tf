output "attestor" {
  description = "Binary Authorization attestor id (projects/*/attestors/*) the bluenose vessel root's attestor variable takes."
  value       = module.supply_chain.attestor
}

output "infra_git_repository_link" {
  description = "The infra repo's Developer Connect link (projects/*/locations/*/connections/*/gitRepositoryLinks/*), what a Cloud Build trigger's developer_connect_event_config takes."
  value       = google_developer_connect_git_repository_link.infra.name
}

output "supply_chain_manifest_block" {
  description = "The installation manifest's supplyChain block: signer key uri and registry namespace."
  value = {
    signer   = module.supply_chain.signer_uri
    registry = module.supply_chain.registry_namespace
  }
}
