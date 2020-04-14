locals {
  name            = coalesce(var.name, var.project_id)
  labels          = merge(var.labels, { managed-by = "terraform" })
  billing_account = coalesce(var.billing_account, null)
}

resource "google_project" "project" {
  name                = local.name
  project_id          = var.project_id
  folder_id           = var.folder_id
  labels              = local.labels
  auto_create_network = false
  billing_account     = local.billing_account
}

resource "google_resource_manager_lien" "project_deletion" {
  parent       = format("projects/%s", google_project.project.id)
  restrictions = ["resourcemanager.projects.delete"]
  origin       = "managed-by-terraform"
  reason       = "This project is managed by terraform"
}

resource "google_compute_project_metadata_item" "oslogin" {
  project = google_project.project.id
  key     = "enable-oslogin"
  value   = "TRUE"
}

resource "google_compute_project_metadata_item" "oslogin_2fa" {
  for_each = var.compute ? toset([1]) : []
  project  = google_project.project.id
  key      = "enable-oslogin-2fa"
  value    = "TRUE"
}

resource "google_compute_project_metadata_item" "guest_attributes" {
  for_each = var.compute ? toset([1]) : []
  project  = google_project.project.id
  key      = "enable-guest-attributes"
  value    = "TRUE"
}

resource "google_compute_project_metadata_item" "os_inventory" {
  for_each = var.compute ? toset([1]) : []
  project  = google_project.project.id
  key      = "enable-os-inventory"
  value    = "TRUE"
}

resource "google_compute_project_metadata_item" "os_config" {
  for_each = var.compute ? toset([1]) : []
  project  = google_project.project.id
  key      = "enable-os-config"
  value    = "TRUE"
}
