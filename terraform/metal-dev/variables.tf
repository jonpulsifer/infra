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

variable "tailscale_client_id" {
  type        = string
  description = "The metal_dev_client_id output of terraform/network/tailscale. The VM joins the tailnet with it; null leaves the VM off the tailnet."
  default     = "TBENabvcXN71CNTRL-keafUurUy521CNTRL"
}

variable "tailscale_audience" {
  type        = string
  description = "The metal_dev_audience output of terraform/network/tailscale: the audience of the identity token the VM trades for an auth key."
  default     = "api.tailscale.com/TBENabvcXN71CNTRL-keafUurUy521CNTRL"

  validation {
    condition     = (var.tailscale_audience == null) == (var.tailscale_client_id == null)
    error_message = "Set tailscale_client_id and tailscale_audience together."
  }
}
