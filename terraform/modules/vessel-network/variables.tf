variable "project" {
  type        = string
  description = "The vessel project the network lives in"
}

variable "region" {
  type        = string
  description = "The region the subnetwork is created in"
}

variable "subnet_cidr" {
  type        = string
  description = "CIDR of the vessel subnet. Read from the vessel's topology SSOT, never typed inline."
}

variable "name" {
  type        = string
  description = "Name shared by the network and subnetwork"
  default     = "spindrift-vessel"
}
