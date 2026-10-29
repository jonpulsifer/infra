output "image" {
  description = "The bucket object the VM image is made from, or null before the first upload."
  value       = local.image_object
}

output "instance" {
  description = "The VM's name and zone, for gcloud, or null while var.on is false."
  value = var.on && local.have_image ? {
    name = google_compute_instance.metal_dev[0].name
    zone = google_compute_instance.metal_dev[0].zone
  } : null
}
