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
      repo_url        = "https://jonpulsifer.github.io/charts"
      chart           = "application"
      target_revision = "0.0.1"
      helm {
        value_files = ["$values/apps/nested/helm/values.yaml"]
        values = yamlencode({
          ingress = {
            hosts = [{
              host = local.nested_hostname
              paths = [{
                path     = "/"
                pathType = "Prefix"
              }]
            }]
            tls = [{
              hosts      = [local.nested_hostname]
              secretName = local.nested_hostname
            }]
          }
        })
      }
    }

    source {
      repo_url        = "https://github.com/jonpulsifer/ts.git"
      target_revision = "HEAD"
      ref             = "values"
      path            = "apps/nested/helm"
    }

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "nested"
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
