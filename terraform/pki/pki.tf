# Per-cluster Kubernetes CAs and SA token signers under the FML intermediate.
# The chain needs root pathLen:2 and intermediate pathLen:1; OpenSSL rejects less, Go does not.
# The intermediate and generated keys pass through the IAM-gated homelab-ng state; the root key never does.

locals {
  clusters = toset(["folly", "offsite"])

  # Standalone 1Password fields land in an unnamed section; flatten every section.
  fml_intermediate_fields = merge([
    for s in data.onepassword_item.fml_intermediate.section : {
      for f in s.field : f.label => f.value
    }
  ]...)
  fml_root_fields = merge([
    for s in data.onepassword_item.fml_root.section : {
      for f in s.field : f.label => f.value
    }
  ]...)

  fml_intermediate_cert = local.fml_intermediate_fields["ca.crt"]
  fml_intermediate_key  = local.fml_intermediate_fields["ca.key"]
  fml_root_cert         = local.fml_root_fields["ca.crt"]
}

# The Atlantis 1Password service account must be able to read these items.
locals {
  op_vault_homelab = "ib23znjeikv74p37f6mbfk7uya"
}

data "onepassword_item" "fml_intermediate" {
  vault = local.op_vault_homelab
  uuid  = "ofl5zkj2rcjnexv3f45wc5i7aq"
}

data "onepassword_item" "fml_root" {
  vault = local.op_vault_homelab
  uuid  = "ujhf4f5cwerdwtpn27fn52kvwq"
}

resource "tls_private_key" "cluster_ca" {
  for_each = local.clusters

  algorithm = "RSA"
  rsa_bits  = 4096
}

# Escrows each cluster CA key; write-only keeps a second copy out of this state.
resource "onepassword_item" "cluster_ca" {
  for_each = local.clusters

  vault    = local.op_vault_homelab
  title    = "FML K8s ${each.key} CA"
  category = "secure_note"

  password_wo         = tls_private_key.cluster_ca[each.key].private_key_pem
  password_wo_version = 1

  lifecycle {
    # Before rotating, keep this item under a versioned resource and title;
    # rollback must not depend on 1Password trash or item history.
    prevent_destroy      = true
    replace_triggered_by = [tls_private_key.cluster_ca[each.key]]
  }

  tags = [
    each.key,
    "kubernetes",
    "pki",
  ]
}

resource "tls_cert_request" "cluster_ca" {
  for_each = local.clusters

  private_key_pem = tls_private_key.cluster_ca[each.key].private_key_pem

  subject {
    common_name  = "FML K8s ${each.key} CA"
    organization = "Folly Mountain Laboratories"
  }
}

resource "tls_locally_signed_cert" "cluster_ca" {
  for_each = local.clusters

  cert_request_pem   = tls_cert_request.cluster_ca[each.key].cert_request_pem
  ca_private_key_pem = local.fml_intermediate_key
  ca_cert_pem        = local.fml_intermediate_cert

  is_ca_certificate = true
  # No effect: Go emits pathLen 0 only with MaxPathLenZero, which the provider cannot set.
  # The intermediate's pathLen:1 enforces the depth; `mise run pki:verify` checks it.
  max_path_length = 0

  validity_period_hours = 2 * 8766 # ~2 years
  early_renewal_hours   = 2160     # plans flag replacement ~90 days out

  allowed_uses = [
    "cert_signing",
    "crl_signing",
    "digital_signature",
  ]
}

resource "tls_private_key" "sa_signer" {
  for_each = local.clusters

  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "tls_cert_request" "sa_signer" {
  for_each = local.clusters

  private_key_pem = tls_private_key.sa_signer[each.key].private_key_pem

  subject {
    common_name  = "FML K8s ${each.key} ServiceAccount token signer"
    organization = "Folly Mountain Laboratories"
  }
}

resource "tls_locally_signed_cert" "sa_signer" {
  for_each = local.clusters

  cert_request_pem   = tls_cert_request.sa_signer[each.key].cert_request_pem
  ca_private_key_pem = tls_private_key.cluster_ca[each.key].private_key_pem
  ca_cert_pem        = tls_locally_signed_cert.cluster_ca[each.key].cert_pem

  is_ca_certificate = false

  validity_period_hours = 8766 # 1 year
  early_renewal_hours   = 720  # plans flag rotation ~30 days out

  allowed_uses = [
    "digital_signature",
  ]
}
