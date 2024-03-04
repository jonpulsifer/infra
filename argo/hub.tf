locals {
  hub_hostname = "hub.lolwtf.ca"
}
resource "argocd_application" "hub" {
  metadata {
    name      = "hub"
    namespace = "argo"
  }

  spec {
    project = "default"

    source {
      repo_url        = "https://github.com/jonpulsifer/ts.git"
      target_revision = "HEAD"
      ref             = "values"
      path            = "apps/hub/k8s"
    }

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "hub"
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
