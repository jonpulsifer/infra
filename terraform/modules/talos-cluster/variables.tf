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
    labels      = optional(map(string), {})
    taints      = optional(map(string), {}) # key => "value:Effect"
    # Replaces the Image Factory installer. Tag it with talos_version and no
    # digest, or Create upgrades the node.
    installer_image = optional(string)
    # A change replaces the node's talos_machine (see nodes.tf).
    install_generation = optional(string)
    # Replaces the bundle's bootstrap token in a worker's config. A worker
    # that joins with a token another system creates for its install alone
    # gets one no Secret holds, so the config this root applies leaves no
    # lasting join credential on its disk.
    bootstrap_token = optional(string)
  }))

  validation {
    condition     = alltrue([for n in var.nodes : contains(["controlplane", "worker"], n.role)])
    error_message = "role must be controlplane or worker."
  }
  validation {
    condition = alltrue([for n in var.nodes : n.bootstrap_token == null || (
      n.role == "worker" && can(regex("^[a-z0-9]{6}\\.[a-z0-9]{16}$", n.bootstrap_token))
    )])
    error_message = "bootstrap_token is for a worker, as <6 of [a-z0-9]>.<16 of [a-z0-9]>: a control plane's config creates the cluster's token."
  }
  validation {
    condition     = length([for n in var.nodes : n if n.role == "controlplane"]) >= 1
    error_message = "A cluster needs a control plane."
  }
}

variable "static_addresses" {
  type        = bool
  description = "Configure every node's address statically: its address in K8S_NODE_CIDR's prefix on its one physical NIC, the default route through ROUTER_IP, and the resolvers below, with no DHCP. Off, Talos runs its default DHCP on every physical link."
  default     = false
}

variable "nameservers" {
  type        = list(string)
  description = "The resolvers of a node with a static address."
  default     = []
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

variable "tpm_nodes" {
  type        = set(string)
  description = "Nodes labelled lolwtf.ca/tpm=true. A fresh install of one makes STATE and EPHEMERAL LUKS2 volumes sealed to the TPM, and kexec is off on them."
  default     = []

  validation {
    condition     = alltrue([for name in var.tpm_nodes : contains(keys(var.nodes), name)])
    error_message = "Every entry of tpm_nodes must be a key of nodes."
  }
}

variable "encrypted_nodes" {
  type        = set(string)
  description = "TPM nodes that were installed with encrypted STATE and EPHEMERAL. Only these get the encryption documents while running; a plain-installed node that gets them fails its next boot."
  default     = []

  validation {
    condition     = alltrue([for name in var.encrypted_nodes : contains(var.tpm_nodes, name)])
    error_message = "Every entry of encrypted_nodes must be in tpm_nodes."
  }
}
