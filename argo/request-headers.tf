locals {
  request_headers_hostname = "request-headers.lolwtf.ca"
  image_name               = "ghcr.io/jonpulsifer/request-headers"
}
resource "argocd_application" "request_headers" {
  metadata {
    name      = "request-headers"
    namespace = "argo"
  }

  spec {
    project = "default"

    source {
      kustomize {
        images = ["ghcr.io/jonpulsifer/does-not-exist=${local.image_name}:latest"]
      }
      repo_url        = "https://github.com/jonpulsifer/ts.git"
      target_revision = "HEAD"
      ref             = "values"
      path            = "apps/request-headers/k8s"
    }

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "request-headers"
    }

    ignore_difference {
      group = "apps"
      kind  = "Deployment"
      json_pointers = [
        "/spec/replicas",
      ]
    }

    sync_policy {
      managed_namespace_metadata {
        labels = {
          "pod-security.kubernetes.io/enforce" = "restricted"
          "pod-security.kubernetes.io/audit"   = "restricted"
          "pod-security.kubernetes.io/warn"    = "restricted"
        }
      }

      sync_options = ["CreateNamespace=true"]
    }
  }
}
