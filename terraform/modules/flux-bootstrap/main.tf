resource "tls_private_key" "flux" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "github_repository_deploy_key" "this" {
  title      = "Flux (${var.cluster_name})"
  repository = var.github_repo
  key        = tls_private_key.flux.public_key_openssh
  read_only  = "true"
}

# CoreDNS — deployed by Terraform so cluster DNS is available before Flux reconciles.
# RBAC (ServiceAccount, ClusterRole, ClusterRoleBinding) already exists from the
# legacy addonManager and persists in the cluster independently.

resource "kubernetes_config_map_v1" "coredns" {
  metadata {
    name      = "coredns"
    namespace = "kube-system"
  }
  data = {
    "Corefile" = <<-EOT
    .:53 {
        errors
        health :8080 {
            lameduck 10s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        prometheus :9153
        forward . ${var.router_ip}
        cache 30
        loop
        reload
        loadbalance
    }
    EOT
  }
}

resource "kubernetes_service_v1" "kube_dns" {
  metadata {
    name      = "kube-dns"
    namespace = "kube-system"
    labels = {
      "k8s-app"                       = "kube-dns"
      "kubernetes.io/cluster-service" = "true"
    }
    annotations = {
      "prometheus.io/scrape" = "true"
      "prometheus.io/port"   = "9153"
    }
  }
  spec {
    cluster_ip = var.cluster_dns
    port {
      name        = "dns"
      port        = 53
      protocol    = "UDP"
      target_port = 53
    }
    port {
      name        = "dns-tcp"
      port        = 53
      protocol    = "TCP"
      target_port = 53
    }
    port {
      name        = "metrics"
      port        = 9153
      protocol    = "TCP"
      target_port = 9153
    }
    selector = {
      "k8s-app" = "kube-dns"
    }
  }
}

resource "kubernetes_deployment_v1" "coredns" {
  metadata {
    name      = "coredns"
    namespace = "kube-system"
    labels = {
      "k8s-app"            = "kube-dns"
      "kubernetes.io/name" = "CoreDNS"
    }
  }
  spec {
    replicas = 1
    strategy {
      type = "RollingUpdate"
      rolling_update {
        max_unavailable = "1"
      }
    }
    selector {
      match_labels = {
        "k8s-app" = "kube-dns"
      }
    }
    template {
      metadata {
        labels = {
          "k8s-app" = "kube-dns"
        }
      }
      spec {
        priority_class_name             = "system-cluster-critical"
        service_account_name            = "coredns"
        dns_policy                      = "Default"
        automount_service_account_token = false
        toleration {
          key      = "CriticalAddonsOnly"
          operator = "Exists"
        }
        toleration {
          key    = "node-role.kubernetes.io/control-plane"
          effect = "NoSchedule"
        }
        node_selector = {
          "kubernetes.io/os" = "linux"
        }
        container {
          name              = "coredns"
          image             = "coredns/coredns:1.11.4"
          image_pull_policy = "IfNotPresent"
          args              = ["-conf", "/etc/coredns/Corefile"]
          port {
            container_port = 53
            name           = "dns"
            protocol       = "UDP"
          }
          port {
            container_port = 53
            name           = "dns-tcp"
            protocol       = "TCP"
          }
          port {
            container_port = 9153
            name           = "metrics"
            protocol       = "TCP"
          }
          liveness_probe {
            http_get {
              path = "/health"
              port = 8080
            }
            initial_delay_seconds = 60
            timeout_seconds       = 5
          }
          readiness_probe {
            http_get {
              path = "/ready"
              port = 8181
            }
            initial_delay_seconds = 30
            timeout_seconds       = 5
          }
          volume_mount {
            name       = "config-volume"
            mount_path = "/etc/coredns"
            read_only  = true
          }
          resources {
            limits = {
              memory = "170Mi"
            }
            requests = {
              cpu    = "100m"
              memory = "70Mi"
            }
          }
          security_context {
            allow_privilege_escalation = false
            capabilities {
              add  = ["NET_BIND_SERVICE"]
              drop = ["ALL"]
            }
            read_only_root_filesystem = true
          }
        }
        volume {
          name = "config-volume"
          config_map {
            name = "coredns"
            items {
              key  = "Corefile"
              path = "Corefile"
            }
          }
        }
      }
    }
  }
}

resource "helm_release" "flux_operator" {
  depends_on = [
    kubernetes_deployment_v1.coredns,
  ]

  name             = "flux-operator"
  namespace        = "flux-system"
  repository       = "oci://ghcr.io/controlplaneio-fluxcd/charts"
  chart            = "flux-operator"
  create_namespace = true
}

resource "helm_release" "flux" {
  depends_on = [helm_release.flux_operator]

  name       = "flux"
  namespace  = "flux-system"
  repository = "oci://ghcr.io/controlplaneio-fluxcd/charts"
  chart      = "flux-instance"

  values = [var.flux_values]
}

resource "kubernetes_secret" "main" {
  metadata {
    name      = "flux-github-app-credentials"
    namespace = "flux-system"
  }

  data = {
    identity       = tls_private_key.flux.private_key_pem
    "identity.pub" = tls_private_key.flux.public_key_pem
    known_hosts    = "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg="
  }

  depends_on = [helm_release.flux]
}
