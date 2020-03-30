variable "name" {
  type        = string
  description = "Name for the AppEngine application"
  default     = "app"
}

variable "project" {
  type        = string
  description = "The project that will contain the application"
  default     = ""
}

variable "location" {
  type        = string
  description = "The location, usually a region e.g. northamerica-northeast1"
  default     = "northamerica-northeast1"
}

variable "serving_status" {
  type        = string
  description = "The serving status of the app"
  default     = "SERVING"
}

variable "auth_domain" {
  type        = string
  description = "The domain to authenticate users with when using App Engine's User API"
  # your default should probably be different :)
  default = "pulsifer.ca"
}

variable "enable_stackdriver" {
  type        = bool
  description = "Enable Stackdriver logging, monitoring, etc for the instance service account"
  default     = false
}

variable "firewall_rules" {
  type        = map(object({ action = string, source_range = string, priority = number }))
  description = "List of firewall rules"
  default = {
    "deny all the things" = {
      action       = "DENY"
      source_range = "*"
      priority     = 1337
    },
  }
}

variable "domain_names" {
  #type        = map(object({ domain_name = string, domain_override_strategy = string, ssl_management_type = string, ssl_certificate_id = string }))
  description = "Map of domain names"
  default     = null
}
