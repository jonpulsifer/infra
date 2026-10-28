# Hardware DevID CAs: each key lives in a YubiKey PIV slot on an anchor and never leaves it.
# scripts/devid-ca-yubikey.sh commits each key's CSR to csr/; every CSR here gets a CA certificate.
# The intermediate's pathLen:1 stops a DevID CA from signing another CA.

locals {
  devid_ca_yubikey_hosts = toset([
    for f in fileset("${path.module}/csr", "folly-devid-ca-*.csr") :
    trimsuffix(trimprefix(f, "folly-devid-ca-"), ".csr")
  ])
}

resource "tls_locally_signed_cert" "devid_ca_yubikey" {
  for_each = local.devid_ca_yubikey_hosts

  cert_request_pem   = file("${path.module}/csr/folly-devid-ca-${each.key}.csr")
  ca_private_key_pem = local.fml_intermediate_key
  ca_cert_pem        = local.fml_intermediate_cert

  is_ca_certificate = true
  # No effect, as on the cluster CAs; the intermediate's pathLen:1 enforces the depth.
  max_path_length = 0

  validity_period_hours = 5 * 8766 # ~5 years
  early_renewal_hours   = 4380     # plans flag replacement ~6 months out

  allowed_uses = [
    "cert_signing",
    "crl_signing",
  ]
}
