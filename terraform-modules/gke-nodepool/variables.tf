variable "name" {
  type    = string
  default = "labpool"
}

variable "location" {
  type = string
}

variable "node_count" {
  default = 0
}

variable "image_type" {
  type    = string
  default = "COS_CONTAINERD"
}

variable "disk_size_gb" {
  default = 10
}

variable "kubernetes_version" {
  default = "1.11.6-gke.0"
  type    = string
}

variable "cluster" {
  type    = string
  default = "yourcluster"
}

variable "machine_type" {
  type    = string
  default = "custom-1-1"
}

variable "service_account" {
  type    = string
  default = "foo@your-project.iam.gserviceaccount.com"
}

variable "preemptible" {
  type    = bool
  default = true
}

variable "node_metadata" {
  description = "Adjusts the node metadata service, one of: GCE_METADATA, GKE_METADATA"
  type        = string
  default     = "GKE_METADATA"
}

variable "metadata_cos" {
  description = "GCE instance metadata pairs assigned to the instances in the group"
  type        = map
  default = {
    disable-legacy-endpoints = "true"
    enable-guest-attributes  = "false"
    enable-os-inventory      = "false"
    # enable-oslogin           = "false"
  }
}

variable "metadata_ubuntu" {
  description = "GCE instance metadata pairs assigned to the instances in the group"
  type        = map
  default = {
    disable-legacy-endpoints = "true"
    enable-guest-attributes  = "true"
    enable-os-inventory      = "true"
    # enable-oslogin           = "false"
  }
}

variable "taints" {
  type    = list
  default = []
}

variable "tags" {
  type    = list
  default = []
}

variable "labels" {
  type    = map
  default = {}
}

variable "shielded" {
  description = "Forces the nodes to use shielded (uefi) images and enables secure boot"
  type        = bool
  default     = true
}
