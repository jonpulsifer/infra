locals {
  authme_hostname = "authme.lolwtf.ca"
}
resource "argocd_application" "authme" {
  metadata {
    name      = "authme"
    namespace = "argo"
  }

  spec {
    project = "default"

    source {
      repo_url        = "https://github.com/jonpulsifer/ts.git"
      target_revision = "HEAD"
      ref             = "values"
      path            = "apps/authme/k8s"
    }

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "authme"
    }

    ignore_difference {
      group = "apps"
      kind  = "Deployment"
      json_pointers = [
        "/spec/replicas",
      ]
    }

    sync_policy {
      sync_options = ["CreateNamespace=true"]
    }
  }
}
