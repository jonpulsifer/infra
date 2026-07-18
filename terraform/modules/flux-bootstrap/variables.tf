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
