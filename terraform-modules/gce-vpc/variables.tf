variable "name" {
  type        = string
  description = "The name for the network"
  default     = "vpc"
}

variable "subnet_name" {
  type        = string
  description = "The name for the subnetwork"
  default     = "subnet"
}

variable "auto_create_subnetworks" {
  type        = bool
  description = "Enables the automatic creation of default subnets, the easy button in a pinch"
  default     = false
}

variable "enable_logging" {
  type        = bool
  description = "Enables flow logs (INTERVAL_10_MIN, 0.5 sample, INCLUDE_ALL_METADATA)"
  default     = false
}

variable "ip_cidr_range" {
  type        = string
  description = "The default CIDR for the subnet"
  default     = "10.13.37.0/28"
}

variable "private_api_access" {
  type        = bool
  description = "Access to Google APIs over RFC1918 networks"
  default     = true
}
