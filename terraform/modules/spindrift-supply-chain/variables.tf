variable "project" {
  type        = string
  description = "The artifacts project the supply chain lives in"
}

variable "location" {
  type        = string
  description = "Location of the KMS key ring and of the Artifact Registry repository the grants attach to"
}

variable "controller_member" {
  type        = string
  description = "The IAM member the Spindrift controller acts as"
}

variable "attester_principals" {
  type        = list(string)
  description = "Everything that signs with the attestor's key — one principal per build route that can reach a Target enforcing Binary Authorization. Declare the list as a local in the calling root so an operator reading the root sees who may sign."
}

variable "attestor_viewers" {
  type        = list(string)
  description = "Members granted attestorsViewer beyond the attesters themselves (e.g. the Terraform service account)"
  default     = []
}

variable "verifier_agents" {
  type        = list(string)
  description = "Binary Authorization service agents of the vessels that verify admission against the attestor. Empty on first bootstrap — a vessel's agent exists only after its Binary Authorization API is enabled; add each agent once its vessel does."
  default     = []
}

variable "repository" {
  type        = string
  description = "Artifact Registry repository id the reader/writer grants attach to. The module never creates it — the repository may be shared with non-Spindrift consumers, so it stays declared where it lives."
}

variable "registry_readers" {
  type        = list(string)
  description = "Members granted artifactregistry.reader on the repository — per-vessel pull principals (the vessel's Binary Authorization and serverless robot service agents, the controller)."
  default     = []
}

variable "registry_writers" {
  type        = list(string)
  description = "Members granted artifactregistry.writer on the repository. Defaults to the attesters: every route that signs also pushes, and a cosign signature is itself an object in the repository."
  default     = null
}

variable "key_ring_name" {
  type        = string
  description = "Name of the KMS key ring the module creates. GCP never deletes rings or keys — a rebuild in a project holding an orphaned ring either imports it or picks a fresh name here."
  default     = "keys"
}

variable "signer_key_name" {
  type        = string
  description = "Name of the signer crypto key inside the ring. Same unremovability caveat as the ring."
  default     = "signer"
}

variable "signer_key" {
  type        = string
  description = "Existing KMS crypto key to sign with, as its full resource id (projects/*/locations/*/keyRings/*/cryptoKeys/*). Set it and the module creates no ring or key, only the grants on the one provided."
  default     = null

  validation {
    condition     = var.signer_key == null || can(regex("^projects/[^/]+/locations/[^/]+/keyRings/[^/]+/cryptoKeys/[^/]+$", var.signer_key))
    error_message = "signer_key is the key's Terraform resource id — no gcpkms:// prefix, no /cryptoKeyVersions/N suffix."
  }
}

variable "attestor" {
  type        = string
  description = "Existing Binary Authorization attestor, as projects/*/attestors/*. Set it and the module creates no attestor, note, or IAM on either — the caller arranges those grants where the attestor lives (see README)."
  default     = null

  validation {
    condition     = var.attestor == null || can(regex("^projects/[^/]+/attestors/[^/]+$", var.attestor))
    error_message = "attestor is projects/<project>/attestors/<name>."
  }
}
