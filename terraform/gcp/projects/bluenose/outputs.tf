# The installation manifest shares no state with this root; copy this block into it by hand.
output "vessel_network_block" {
  description = "The installation manifest's bluenose vessel location.network block."
  value = {
    name   = module.network.network_name
    region = module.network.region
  }
}

output "kthx_bucket" {
  description = "The kthx depot bucket — KTHX_BUCKET on the kthx server."
  value       = google_storage_bucket.kthx.name
}
