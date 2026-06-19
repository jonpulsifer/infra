module "jonpulsifer" {
  source          = "./modules/project"
  project_id      = "jonpulsifer"
  folder_id       = google_folder.production.name
  billing_account = data.google_billing_account.cloudlab.id
  labels = {
    environment = "production"
  }
}

module "homelab-ng" {
  source          = "./modules/project"
  project_id      = "homelab-ng"
  name            = "whats a home lab"
  compute         = true
  folder_id       = google_folder.production.name
  billing_account = data.google_billing_account.cloudlab.id
  labels = {
    environment = "home"
  }
}

module "trusted-builds" {
  source          = "./modules/project"
  project_id      = "trusted-builds"
  name            = "trust no one"
  folder_id       = google_folder.production.name
  billing_account = data.google_billing_account.cloudlab.id
  labels = {
    environment = "production"
  }
}

module "kubesec" {
  source          = "./modules/project"
  project_id      = "kubesec"
  name            = "kubesec"
  folder_id       = google_folder.production.name
  compute         = true
  billing_account = data.google_billing_account.cloudlab.id
  labels = {
    environment = "production"
  }
}

module "secure-the-cloud" {
  source          = "./modules/project"
  project_id      = "secure-the-cloud"
  name            = "secure teh cloud"
  folder_id       = google_folder.dev.name
  billing_account = data.google_billing_account.cloudlab.id
  labels = {
    environment = "production"
  }
}

module "cloud-glue" {
  source     = "./modules/project"
  project_id = "cloud-glue"
  name       = "cloud-glue"
  folder_id  = google_folder.dev.name
}

module "lolcorp" {
  source          = "./modules/project"
  project_id      = "lolcorp"
  name            = "lolcorp"
  folder_id       = google_folder.production.name
  billing_account = data.google_billing_account.cloudlab.id
  labels = {
    environment = "production"
  }
}

module "firebees" {
  source          = "./modules/project"
  project_id      = "firebees"
  name            = "firebees"
  folder_id       = google_folder.production.name
  billing_account = data.google_billing_account.cloudlab.id
  labels = {
    environment = "production"
  }
}

module "wishin_app" {
  source          = "./modules/project"
  project_id      = "wishin-app"
  name            = "wishin-app"
  folder_id       = google_folder.production.name
  billing_account = data.google_billing_account.cloudlab.id
  labels = {
    environment = "production"
  }
}
