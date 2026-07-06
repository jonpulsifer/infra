resource "vault_mount" "pki" {
  path                      = "pki"
  type                      = "pki"
  description               = "Folly Mountain Laboratories Intermediate CA"
  default_lease_ttl_seconds = 3600      # 1 hour
  max_lease_ttl_seconds     = 157680000 # 5 years
}

# Import the offline-generated intermediate CA (see pki/offline-root-ceremony.sh)
# as the active CA on this mount. Optional: count=0 when the bundle isn't
# supplied (e.g. before the first ceremony runs or in CI / Atlantis dry runs),
# preserving the previous behaviour of an unconfigured mount.
resource "vault_pki_secret_backend_config_ca" "offline_intermediate" {
  count      = var.pki_intermediate_pem_bundle == null ? 0 : 1
  backend    = vault_mount.pki.path
  pem_bundle = var.pki_intermediate_pem_bundle
}

resource "vault_pki_secret_backend_config_urls" "config_urls" {
  backend                 = vault_mount.pki.path
  issuing_certificates    = ["http://127.0.0.1:8200/v1/pki/ca"]
  crl_distribution_points = ["http://127.0.0.1:8200/v1/pki/crl"]
}

resource "vault_pki_secret_backend_role" "fml" {
  backend          = vault_mount.pki.path
  name             = "fml.pulsifer.ca"
  allow_ip_sans    = true
  key_type         = "ec"
  key_bits         = 521
  allowed_domains  = ["fml.pulsifer.ca"]
  allow_subdomains = true
  key_usage = [
    "DigitalSignature",
    "KeyAgreement",
    "KeyEncipherment"
  ]
}

resource "vault_pki_secret_backend_role" "lolwtf" {
  backend          = vault_mount.pki.path
  name             = "lolwtf"
  allow_ip_sans    = true
  key_type         = "ec"
  key_bits         = 521
  allowed_domains  = ["lolwtf.ca", "lolwtf.dev"]
  allow_subdomains = true
  key_usage = [
    "DigitalSignature",
    "KeyAgreement",
    "KeyEncipherment"
  ]
}
