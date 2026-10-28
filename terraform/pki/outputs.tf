output "issuers" {
  description = "Per-cluster OIDC issuer URLs (the kube-apiserver --service-account-issuer values)."
  value       = { for c in local.clusters : c => "${local.issuer_base}/${c}" }
}

output "cluster_ca_certs" {
  description = "Per-cluster FML K8s CA certificates (PEM)."
  value       = { for c in local.clusters : c => tls_locally_signed_cert.cluster_ca[c].cert_pem }
}

output "cluster_ca_private_keys" {
  description = "Per-cluster FML K8s CA private keys (PEM). Consumed only by scripts/pki/post-rotate.sh, which sops-encrypts each key for its control-plane host."
  sensitive   = true
  value       = { for c in local.clusters : c => tls_private_key.cluster_ca[c].private_key_pem }
}

output "sa_signer_certs" {
  description = "Per-cluster ServiceAccount token signer certificates (PEM)."
  value       = { for c in local.clusters : c => tls_locally_signed_cert.sa_signer[c].cert_pem }
}

output "sa_signer_chains" {
  description = "Signer -> cluster CA -> FML intermediate chains (PEM), for kube-apiserver --service-account-key-file."
  # Public certs, but the intermediate comes from a 1Password data source that
  # the provider marks sensitive, so tofu requires the flag.
  sensitive = true
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
  sensitive   = true
}

output "fml_intermediate_cert" {
  description = "FML Intermediate CA certificate (PEM)."
  value       = local.fml_intermediate_cert
  sensitive   = true
}

output "devid_ca_cert" {
  description = "folly's software DevID CA certificate (PEM). scripts/pki/devid-ca.sh writes it to certs/folly-devid-ca-software.pem."
  value       = tls_locally_signed_cert.devid_ca.cert_pem
}

output "devid_ca_chain" {
  description = "Software DevID CA, FML intermediate, FML root (PEM), the DevID CA first, for apps/talos-attest's ATTEST_CA_CHAIN. scripts/pki/devid-ca.sh writes it to certs/folly-devid-ca-software-chain.pem."
  # Public certs, but the intermediate and root come from 1Password data
  # sources, which the provider marks sensitive.
  sensitive = true
  # The 1Password certs end without a newline; trimspace and a "\n" join keep
  # each PEM block on its own lines.
  value = "${join("\n", [
    trimspace(tls_locally_signed_cert.devid_ca.cert_pem),
    trimspace(local.fml_intermediate_cert),
    trimspace(local.fml_root_cert),
  ])}\n"
}

output "devid_ca_private_key" {
  description = "folly's DevID CA private key (PKCS#8 PEM). Consumed only by scripts/pki/devid-ca.sh, which sops-encrypts it for each anchor."
  sensitive   = true
  value       = tls_private_key.devid_ca.private_key_pem_pkcs8
}

output "devid_ca_yubikey_certs" {
  description = "Hardware DevID CA certificates (PEM), by anchor. scripts/devid-ca-yubikey.sh writes each to certs/folly-devid-ca-<host>.pem."
  value       = { for h in local.devid_ca_yubikey_hosts : h => tls_locally_signed_cert.devid_ca_yubikey[h].cert_pem }
}

output "devid_ca_bundle" {
  description = "Every issuing DevID CA (PEM) in file-name order: each committed certs/folly-devid-ca-<name>.pem but the -chain.pem files, with this root's software and hardware CAs at their file names. `mise run devid:bundle` writes the same bundle to certs/folly-devid-ca.pem."
  value = join("", [for pem in values(merge(
    { for f in fileset("${path.module}/certs", "folly-devid-ca-*.pem") : f => file("${path.module}/certs/${f}") if !endswith(f, "-chain.pem") },
    { "folly-devid-ca-software.pem" = tls_locally_signed_cert.devid_ca.cert_pem },
    { for h in local.devid_ca_yubikey_hosts : "folly-devid-ca-${h}.pem" => tls_locally_signed_cert.devid_ca_yubikey[h].cert_pem },
  )) : "${trimspace(pem)}\n"])
}
