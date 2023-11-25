locals {
  request_headers_hostname = "request-headers.lolwtf.ca"
}
resource "argocd_application" "request_headers" {
  metadata {
    name      = "request-headers"
    namespace = "argo"
  }

  spec {
    project = "default"

    source {
      repo_url        = "https://github.com/jonpulsifer/ts.git"
      target_revision = "HEAD"
      ref             = "values"
      path            = "apps/request-headers/k8s"
    }

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "request-headers"
    }

    sync_policy {
      automated {
        prune     = true
        self_heal = true
      }
      sync_options = ["CreateNamespace=true"]
    }
  }
}
