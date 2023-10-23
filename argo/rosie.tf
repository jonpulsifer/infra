resource "argocd_application" "rosie" {
  metadata {
    name      = "rosie"
    namespace = "argo"
  }

  spec {
    project = "default"

    source {
      repo_url        = "https://jonpulsifer.github.io/charts"
      chart           = "application"
      target_revision = "0.0.10"
      helm {
        value_files = ["$values/apps/rosie/helm/values.yaml"]
        values = yamlencode({
          ingress = {
            enabled = false
          }
        })
      }
    }

    source {
      repo_url        = "https://github.com/jonpulsifer/ts.git"
      target_revision = "HEAD"
      ref             = "values"
      path            = "apps/rosie/helm"
    }

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "rosie"
    }

    ignore_difference {
      group         = "apps"
      kind          = "Deployment"
      json_pointers = ["/spec/template/spec/securityContext"]
    }

    sync_policy {
      automated {
        prune     = true
        self_heal = true
      }
      sync_options = ["CreateNamespace=false"]
    }
  }
}
