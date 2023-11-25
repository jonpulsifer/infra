locals {
  nested_hostname = "nested.lolwtf.ca"
}
resource "argocd_application" "nested" {
  metadata {
    name      = "nested"
    namespace = "argo"
  }

  spec {
    project = "default"

    source {
      repo_url        = "https://github.com/jonpulsifer/ts.git"
      target_revision = "HEAD"
      ref             = "values"
      path            = "apps/nested/k8s"
    }

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "nested"
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
