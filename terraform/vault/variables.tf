variable "pki_intermediate_pem_bundle" {
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
  description = <<-EOT
    PEM bundle (private key followed by certificate) of the offline-generated
    intermediate CA. When set, terraform/vault imports it as the active CA on
    the `pki` mount via vault_pki_secret_backend_config_ca — letting Vault
    issue leaf certs signed by the offline-rooted intermediate.

    Leave null to apply the Vault PKI mount + roles without any CA configured
    (matches the previous behaviour, e.g. before the first offline ceremony
    has been run). Pass via TF_VAR so the bundle never lands in git:

      TF_VAR_pki_intermediate_pem_bundle="$(cat pki/export/intermediate.pem)" \
        terraform -chdir=terraform/vault apply
  EOT
}