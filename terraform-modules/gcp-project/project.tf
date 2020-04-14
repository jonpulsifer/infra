locals {
  labels = merge(var.labels, { managed-by = "terraform" })
}

resource "google_project" "project" {
  name                = coalesce(var.name, var.project_id)
  project_id          = var.project_id
  folder_id           = var.folder_id
  labels              = local.labels
  auto_create_network = false
  billing_account     = var.billing_account
}

resource "google_resource_manager_lien" "project_deletion" {
  parent       = google_project.project.id
  restrictions = ["resourcemanager.projects.delete"]
  origin       = "managed-by-terraform"
  reason       = "This project is managed by terraform"
  depends_on = [
    google_project.project
  ]
}

resource "google_compute_project_metadata_item" "oslogin" {
  for_each = var.compute ? toset([var.project_id]) : []
  project  = each.key
  key      = "enable-oslogin"
  value    = "TRUE"
  depends_on = [
    google_project.project
  ]
}

resource "google_compute_project_metadata_item" "oslogin_2fa" {
  for_each = var.compute ? toset([var.project_id]) : []
  project  = each.key
  key      = "enable-oslogin-2fa"
  value    = "TRUE"
  depends_on = [
    google_project.project
  ]
}

resource "google_compute_project_metadata_item" "guest_attributes" {
  for_each = var.compute ? toset([var.project_id]) : []
  project  = each.key
  key      = "enable-guest-attributes"
  value    = "TRUE"
  depends_on = [
    google_project.project
  ]
}

resource "google_compute_project_metadata_item" "os_inventory" {
  for_each = var.compute ? toset([var.project_id]) : []
  project  = each.key
  key      = "enable-os-inventory"
  value    = "TRUE"
  depends_on = [
    google_project.project
  ]
}

resource "google_compute_project_metadata_item" "os_config" {
  for_each = var.compute ? toset([var.project_id]) : []
  project  = each.key
  key      = "enable-os-config"
  value    = "TRUE"
  depends_on = [
    google_project.project
  ]
}
