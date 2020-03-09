data "google_client_config" "current" {}
variable "name" {
  type        = string
  description = "The name for the network"
  default     = "lab"
}

variable "enable_logging" {
  type        = bool
  description = "Enables flow logs (INTERVAL_10_MIN, 0.5 sample, INCLUDE_ALL_METADATA)"
  default     = false
}

variable "vm_cidr" {
  type        = string
  description = "The default CIDR for the cloudlab VMs"
  default     = "10.13.37.0/28"
}

variable "private_api_access" {
  type        = bool
  description = "Access to Google APIs over RFC1918 networks"
  default     = true
}
