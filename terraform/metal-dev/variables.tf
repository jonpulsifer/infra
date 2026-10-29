variable "on" {
  type        = bool
  description = "Declare the VM and its disk. Off, the root keeps only the network, the service account and the image, which cost nothing."
  default     = false
}

variable "machine_type" {
  type        = string
  description = "An Intel machine type that supports nested virtualization. N2 does; E2 and shared-core types do not."
  default     = "n2-standard-8"

  validation {
    condition     = can(regex("^(n2|n1|c2|c3|n2d)-", var.machine_type))
    error_message = "Nested virtualization needs an N1, N2, N2D, C2 or C3 machine type."
  }
}

variable "disk_gb" {
  type        = number
  description = "Boot disk size. The mirrored release images and each virtual node's disk live on it."
  default     = 100
}
