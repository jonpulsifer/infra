resource "argocd_application" "rosie" {
  metadata {
    name      = "rosie"
    namespace = "argo"
  }

  spec {
    project = "default"

    source {
      repo_url        = "https://github.com/jonpulsifer/ts.git"
      target_revision = "HEAD"
      ref             = "values"
      path            = "apps/rosie/k8s"
    }

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "rosie"
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
