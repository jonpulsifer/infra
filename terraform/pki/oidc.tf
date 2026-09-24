# scripts/pki/post-rotate.sh writes each cluster's discovery documents to oidc/<cluster>/.
# .github/workflows/oidc.yml publishes them to the Pages project in network/cloudflare.

locals {
  issuer_base = "https://oidc.lolwtf.ca"
}
