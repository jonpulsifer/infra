# FML PKI: per-cluster Kubernetes CAs and ServiceAccount token signers.
#
#   FML Root CA (offline; 1P ujhf4f5cwerdwtpn27fn52kvwq, ca.crt only)
#   └─ FML Intermediate CA (1P ofl5zkj2rcjnexv3f45wc5i7aq, ca.crt + ca.key)
#      └─ FML K8s <cluster> CA (issued here; CA:TRUE, pathLen:0)
#         └─ <cluster> SA token signer (issued here; leaf, RSA-4096, 1y)
#
# The intermediate's private key is read from 1Password at plan/apply time and
# therefore transits Terraform state, as do the generated private keys. This is
# a deliberate tradeoff (state lives in the IAM-gated homelab-ng bucket); the
# root CA key never touches Terraform. Signer private keys reach the NixOS
# control planes via scripts/pki/post-rotate.sh -> sops (never committed).

locals {
  clusters = toset(["folly", "offsite"])

  # Item fields land in provider sections; standalone fields surface in an
  # unnamed section. Flatten them all into one label->value map per item.
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

# 1Password "homelab" vault; the Atlantis op service account must be able to
# read these items.
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

# --- Per-cluster K8s CA (intermediate, pathLen:0) -------------------------

resource "tls_private_key" "cluster_ca" {
  for_each = local.clusters

  algorithm = "RSA"
  rsa_bits  = 4096
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
  # Guardrail: this CA may only issue end-entity certs, never another CA.
  max_path_length = 0

  validity_period_hours = 2 * 8766 # ~2 years
  early_renewal_hours   = 2160     # plans flag replacement ~90 days out

  allowed_uses = [
    "cert_signing",
    "crl_signing",
    "digital_signature",
  ]
}

# --- Per-cluster ServiceAccount token signer (leaf) -----------------------

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

  validity_period_hours = 8766 # 1 year: hard cryptographic-lifecycle bound
  early_renewal_hours   = 720  # plans flag rotation ~30 days out

  allowed_uses = [
    "digital_signature",
  ]
}
