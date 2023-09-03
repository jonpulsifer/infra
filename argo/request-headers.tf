locals {
  hostname = "request-headers-tf.lolwtf.ca"
}
resource "argocd_application" "request_headers_tf" {
  metadata {
    name      = "request-headers-tf"
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
              host = local.hostname
              paths = [{
                path     = "/"
                pathType = "Prefix"
              }]
            }]
            tls = [{
              hosts      = [local.hostname]
              secretName = local.hostname
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
      namespace = "request-headers-tf"
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
