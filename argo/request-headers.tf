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
      repo_url        = "https://jonpulsifer.github.io/charts"
      chart           = "nextjs"
      target_revision = "0.0.1"
      helm {
        value_files = ["$values/apps/request-headers/helm/values.yaml"]
        values = yamlencode({
          ingress = {
            hosts = [{
              host = local.request_headers_hostname
              paths = [{
                path     = "/"
                pathType = "Prefix"
              }]
            }]
            tls = [{
              hosts      = [local.request_headers_hostname]
              secretName = local.request_headers_hostname
            }]
          }
        })
      }
    }

    source {
      repo_url        = "https://github.com/jonpulsifer/ts.git"
      target_revision = "HEAD"
      ref             = "values"
      path            = "apps/request-headers/helm"
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
