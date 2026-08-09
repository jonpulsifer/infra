variable "project" {
  type        = string
  description = "The project this vessel is, in the boundary's own terms"
}

variable "controller_member" {
  type        = string
  description = "The IAM member the Spindrift controller acts as in this vessel"
}

variable "services" {
  type        = list(string)
  description = "APIs enabled on the vessel. Pass this list from the root's services.tf so Spindrift's generated remediation stanzas can see the quoted service strings where they look for them."
}

variable "controller_roles" {
  type        = list(string)
  description = "Project roles the controller holds here. Pass from the root's iam.tf, for the same remediation-visibility reason as services."
}

variable "runtime_account_id" {
  type        = string
  description = "Account id of the runtime service account revisions and jobs run as"
  default     = "spindrift-runtime"
}

variable "attestor" {
  type        = string
  description = "The Binary Authorization attestor every container admission must carry, as projects/*/attestors/* — the spindrift-supply-chain module's attestor output"
}
