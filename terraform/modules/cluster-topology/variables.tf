variable "site" {
  type        = string
  description = "Cluster site whose topology ConfigMap to read (folly or offsite)."

  validation {
    condition     = contains(["folly", "offsite"], var.site)
    error_message = "site must be \"folly\" or \"offsite\"."
  }
}

variable "config_map" {
  type        = string
  description = "Topology ConfigMap filename without the .json suffix."
  default     = "cluster-topology"

  validation {
    condition     = contains(["cluster-topology", "lab-topology"], var.config_map)
    error_message = "config_map must be \"cluster-topology\" or \"lab-topology\"."
  }
}
