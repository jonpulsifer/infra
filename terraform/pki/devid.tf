# folly's DevID CA, one level under the FML intermediate, which allows exactly one CA below it.
# It issues each attested machine's LDevID and LAK certificates (apps/talos-attest). Its key is a
# software key in this state; the YubiKey-held issuing CAs of devid-ca.tf sit beside it.
# scripts/pki/devid-ca.sh commits the certificate and chain and seals the key for the anchors.

resource "tls_private_key" "devid_ca" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "devid_ca" {
  private_key_pem = tls_private_key.devid_ca.private_key_pem

  subject {
    common_name  = "FML DevID folly CA"
    organization = "Folly Mountain Laboratories"
  }
}

resource "tls_locally_signed_cert" "devid_ca" {
  cert_request_pem   = tls_cert_request.devid_ca.cert_request_pem
  ca_private_key_pem = local.fml_intermediate_key
  ca_cert_pem        = local.fml_intermediate_cert

  is_ca_certificate = true
  # No effect, as on the cluster CAs: the intermediate's pathLen:1 bounds the depth.
  max_path_length = 0

  validity_period_hours = 5 * 8766 # ~5 years
  early_renewal_hours   = 2160     # plans flag replacement ~90 days out

  allowed_uses = [
    "cert_signing",
    "crl_signing",
  ]
}
