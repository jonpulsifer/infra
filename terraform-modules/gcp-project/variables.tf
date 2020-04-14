variable "project_id" {
  type        = string
  description = "Required. The project id, 6 to 30 lowercase letters, digits, or hyphens."
  default     = null
}

variable "folder_id" {
  type        = string
  description = "The parent folder for this project."
  default     = null
}

variable "billing_account" {
  type        = string
  description = "The billing account for the project"
  default     = null
}

variable "labels" {
  type        = set(any)
  description = "The labels for the project"
}

variable "name" {
  type        = string
  description = "Optional. The name for the project (human readable)"
  default     = null
}

variable "compute" {
  type        = bool
  description = "Default false. Whether or not to enable the compute metadata at the project level"
  default     = false
}
