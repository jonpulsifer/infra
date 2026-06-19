# locals {
#   vault_port   = 8200
#   vault_config = <<EOF
# {
#   "api_addr": "https://0.0.0.0:${local.vault_port}",
#   "cluster_addr": "https://0.0.0.0:8201",
#   "listener": {
#     "tcp": {
#       "address" : "0.0.0.0:${local.vault_port}",
#       "tls_disable" : true,
#       "tls_disable_client_certs" : true
#     }
#   },
#   "seal": {
#     "gcpckms": {
#       "crypto_key" : "vault",
#       "key_ring" : "vault",
#       "project" : "${local.project}",
#       "region" : "${local.region}"
#     }
#   },
#   "storage": {
#     "gcs": {
#       "bucket" : "${resource.google_storage_bucket.vault.name}",
#       "ha_enabled" : "false"
#     }
#   },
#   "ui": true
# }
# EOF
# }

# resource "google_cloud_run_v2_service" "vault" {
#   name     = "vault"
#   location = local.region
#   ingress  = "INGRESS_TRAFFIC_ALL"


#   template {
#     scaling {
#       max_instance_count = 1
#     }
#     service_account = google_service_account.vault.email
#     containers {
#       image = "hashicorp/vault"
#       args  = ["server"]
#       resources {
#         cpu_idle = true
#         limits = {
#           cpu    = "1000m"
#           memory = "512Mi"
#         }
#       }
#       ports {
#         container_port = local.vault_port
#       }
#       # startup_probe {
#       #   failure_threshold     = 5
#       #   initial_delay_seconds = 3
#       #   timeout_seconds       = 3
#       #   period_seconds        = 3
#       #   http_get {
#       #     path = "/v1/sys/health"
#       #     port = local.vault_port
#       #   }
#       # }
#       # liveness_probe {
#       #   http_get {
#       #     path = "/v1/sys/health"
#       #     port = local.vault_port
#       #   }
#       # }
#       env {
#         name  = "SKIP_SETCAP"
#         value = "true"
#       }
#       env {
#         name  = "VAULT_LOCAL_CONFIG"
#         value = local.vault_config
#       }
#     }
#   }
# }
