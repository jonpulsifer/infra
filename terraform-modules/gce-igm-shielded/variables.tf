locals {
  device_name = var.encrypt_disk ? "encrypted-boot" : "boot"
  project     = var.project
  cloudlab    = var.cloudlab
}

data "google_project" "current" {
  project_id = local.project
}

variable "name" {
  type        = string
  description = "Name for the service account and VM prefix"
  default     = "lab"
}

variable "project" {
  type        = string
  description = "The project that will contain the resources"
  default     = ""
}

variable "location" {
  type        = string
  description = "The location, usually a region e.g. northamerica-northeast1"
  default     = ""
}

variable "external_ip" {
  type        = bool
  description = "Create an external IP address for the instance"
  default     = false
}

variable "image" {
  type        = map(string)
  description = "Map that holds the GCE image family and project"
  default = {
    project = "gce-uefi-images"
    family  = "cos-beta"
  }
}

variable "machine_type" {
  type        = string
  description = "GCE Machine Type"
  default     = "n1-standard-1"
}

variable "preemptible" {
  type        = string
  description = "Toggle if the instance is preemptible. Defaults to true"
  default     = "true"
}

variable "subnet" {
  type        = string
  description = "Which subnet to deploy into"
  default     = "10.13.37.0/29"
}

variable "cloud_init" {
  type        = string
  description = "the user-data cloud-init script"
  default     = <<HEREDOC
#cloud-config
HEREDOC
}

variable "target_size" {
  type        = number
  description = "Count of instances to create (zonal)"
  default     = 1
}

variable "enable_lb" {
  type        = bool
  description = "Enables or disables load balancing"
  default     = false
}

variable "port_range" {
  type        = string
  description = "Port range for the load balancer"
  default     = ""
}

variable "protocol" {
  type        = string
  description = "IP protocol for the load balancer"
  default     = "TCP"
}

variable "target_pools" {
  type        = list
  description = "List of the target pools this igm belongs to"
  default     = []
}

variable "encrypt_disk" {
  type        = bool
  description = "Whether or not to encrypt the disk with KMS"
  default     = true
}

variable "enable_stackdriver" {
  type        = bool
  description = "Enable Stackdriver logging, monitoring, etc for the instance service account"
  default     = true
}

variable "cloudlab" {
  type        = bool
  description = "Enable access to the gs://cloud-lab bucket. Caller must have permission to set the IAM policy"
  default     = true
}

variable "can_ip_forward" {
  type        = bool
  description = "Whether or not the instance can forward packets (eg wireguard needs this)"
  default     = false
}
