variable "site" {
  type        = string
  description = "Cluster site whose cluster-topology.json to read (folly or offsite)."

  validation {
    condition     = contains(["folly", "offsite"], var.site)
    error_message = "site must be \"folly\" or \"offsite\"."
  }
}
