variable "cluster_name" {
  type        = string
  description = "Cluster identity used in the Flux deploy-key title."
}

variable "github_repo" {
  type        = string
  description = "GitHub repository that Flux reads."
}

variable "flux_values" {
  type        = string
  description = "Rendered values for the flux-instance Helm release."
}

variable "cluster_dns" {
  type        = string
  description = "ClusterIP for the CoreDNS kube-dns Service (from cluster-topology CLUSTER_DNS)."
}

variable "router_ip" {
  type        = string
  description = "Upstream DNS forwarder IP for CoreDNS (from cluster-topology ROUTER_IP)."
}
