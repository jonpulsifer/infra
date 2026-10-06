variable "site" {
  type        = string
  description = "Cluster site (folly or offsite). Selects the topology ConfigMap."

  validation {
    condition     = contains(["folly", "offsite"], var.site)
    error_message = "site must be \"folly\" or \"offsite\"."
  }
}

variable "talos_version" {
  type        = string
  description = "Installer tag, e.g. v1.14.2. Changing it upgrades every node (a reboot each)."

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+$", var.talos_version))
    error_message = "talos_version must look like v1.14.2."
  }
}

variable "talos_contract" {
  type        = string
  description = "Machine-config version contract passed to the generator. Pinned at the version the cluster was created with; never bumped on an OS upgrade."
  default     = "v1.14"
}

variable "kubernetes_version" {
  type        = string
  description = "Kubernetes version, e.g. v1.36.3. Changing it runs upgrade-k8s through talos_cluster."

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+$", var.kubernetes_version))
    error_message = "kubernetes_version must look like v1.36.3."
  }
}

variable "extensions" {
  type        = list(string)
  description = "Official Image Factory system extensions baked into the schematic."
}

variable "extra_kernel_args" {
  type        = list(string)
  description = "Kernel arguments baked into the schematic (UKI installs cannot change them any other way)."
  default     = []
}

variable "op_vault" {
  type        = string
  description = "1Password vault UUID that holds the secrets bundle. The Atlantis service account must read it."
}

variable "secrets_item_uuid" {
  type        = string
  description = "UUID of the 1Password Secure Note whose note is this cluster's secrets.yaml (talosctl gen secrets shape, with the imported service-account signing key)."
}

variable "nodes" {
  description = "Every machine in the cluster, keyed by hostname."
  type = map(object({
    address     = string
    role        = string # controlplane | worker
    install     = string # CEL disk selector, e.g. disk.dev_path == "/dev/sda"
    reboot_mode = optional(string, "DEFAULT")
    patches     = optional(list(string), [])
  }))

  validation {
    condition     = alltrue([for n in var.nodes : contains(["controlplane", "worker"], n.role)])
    error_message = "role must be controlplane or worker."
  }
  validation {
    condition     = length([for n in var.nodes : n if n.role == "controlplane"]) == 1
    error_message = "This lab runs exactly one control plane per cluster."
  }
}

variable "workload_isolation" {
  type        = bool
  description = "SecurityProfileConfig.workloadIsolation (sandboxd). Talos 1.14 defaults new clusters to true."
  default     = true
}

variable "cluster_patches" {
  type        = list(string)
  description = "Multi-document YAML patches appended to every node after the module's own (CNI inline manifest, sysctls, volumes)."
  default     = []
}

variable "controlplane_patches" {
  type        = list(string)
  description = "Patches appended to the control plane only (KubeServiceAccountConfig, KubeAuthenticationConfig, KubeAPIServerConfig extraArgs)."
  default     = []
}
