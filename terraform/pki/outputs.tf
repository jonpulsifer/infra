output "issuers" {
  description = "Per-cluster OIDC issuer URLs (the kube-apiserver --service-account-issuer values)."
  value       = { for c in local.clusters : c => "${local.issuer_base}/${c}" }
}

output "cluster_ca_certs" {
  description = "Per-cluster FML K8s CA certificates (PEM)."
  value       = { for c in local.clusters : c => tls_locally_signed_cert.cluster_ca[c].cert_pem }
}

output "sa_signer_certs" {
  description = "Per-cluster ServiceAccount token signer certificates (PEM)."
  value       = { for c in local.clusters : c => tls_locally_signed_cert.sa_signer[c].cert_pem }
}

output "sa_signer_chains" {
  description = "Signer -> cluster CA -> FML intermediate chains (PEM), for kube-apiserver --service-account-key-file."
  value = { for c in local.clusters : c => join("", [
    tls_locally_signed_cert.sa_signer[c].cert_pem,
    tls_locally_signed_cert.cluster_ca[c].cert_pem,
    local.fml_intermediate_cert,
  ]) }
}

output "sa_signer_private_keys" {
  description = "Per-cluster signer private keys (PEM). Consumed only by scripts/pki/post-rotate.sh, which sops-encrypts them for the control-plane hosts."
  sensitive   = true
  value       = { for c in local.clusters : c => tls_private_key.sa_signer[c].private_key_pem }
}

output "fml_root_cert" {
  description = "FML Root CA certificate (PEM)."
  value       = local.fml_root_cert
}

output "fml_intermediate_cert" {
  description = "FML Intermediate CA certificate (PEM)."
  value       = local.fml_intermediate_cert
}
