# 800g2 (nNSXa45CNTRL)
resource "tailscale_device_authorization" "device_800g2" {
  device_id  = "nNSXa45CNTRL"
  authorized = true
}

resource "tailscale_device_key" "device_800g2" {
  device_id           = "nNSXa45CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "device_800g2" {
  device_id = "nNSXa45CNTRL"
  tags      = ["tag:folly"]
}

# Chromebook_A288 (n32GMNpnsi11CNTRL)
resource "tailscale_device_authorization" "chromebook_a288" {
  device_id  = "n32GMNpnsi11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "chromebook_a288" {
  device_id           = "n32GMNpnsi11CNTRL"
  key_expiry_disabled = false
}

# Craftbook Air (n7zraF9qUH11CNTRL)
resource "tailscale_device_authorization" "craftbook_air" {
  device_id  = "n7zraF9qUH11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "craftbook_air" {
  device_id           = "n7zraF9qUH11CNTRL"
  key_expiry_disabled = false
}

# DESKTOP-G7I75LS (ntQTpYoZG311CNTRL)
resource "tailscale_device_authorization" "desktop_g7i75ls" {
  device_id  = "ntQTpYoZG311CNTRL"
  authorized = true
}

resource "tailscale_device_key" "desktop_g7i75ls" {
  device_id           = "ntQTpYoZG311CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "desktop_g7i75ls" {
  device_id = "ntQTpYoZG311CNTRL"
  tags      = ["tag:offsite"]
}

# atomic (naXDKP4CNTRL)
resource "tailscale_device_authorization" "atomic" {
  device_id  = "naXDKP4CNTRL"
  authorized = true
}

resource "tailscale_device_key" "atomic" {
  device_id           = "naXDKP4CNTRL"
  key_expiry_disabled = true
}

# cloudpi4 (nKnaKY7CNTRL)
resource "tailscale_device_authorization" "cloudpi4" {
  device_id  = "nKnaKY7CNTRL"
  authorized = true
}

resource "tailscale_device_key" "cloudpi4" {
  device_id           = "nKnaKY7CNTRL"
  key_expiry_disabled = true
}

# folly-k8s-lan-router-0 (nT6Ro2Ptvo11CNTRL)
resource "tailscale_device_authorization" "folly_k8s_lan_router_0" {
  device_id  = "nT6Ro2Ptvo11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "folly_k8s_lan_router_0" {
  device_id           = "nT6Ro2Ptvo11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "folly_k8s_lan_router_0" {
  device_id = "nT6Ro2Ptvo11CNTRL"
  tags      = ["tag:folly", "tag:k8s", "tag:k8s-folly"]
}

# folly-k8s-lan-router-0 (npaZfYUW8w11CNTRL)
resource "tailscale_device_authorization" "folly_k8s_lan_router_0_npazfyuw" {
  device_id  = "npaZfYUW8w11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "folly_k8s_lan_router_0_npazfyuw" {
  device_id           = "npaZfYUW8w11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "folly_k8s_lan_router_0_npazfyuw" {
  device_id = "npaZfYUW8w11CNTRL"
  tags      = ["tag:folly", "tag:k8s", "tag:k8s-folly"]
}

# homepi4 (nnLYWS5CNTRL)
resource "tailscale_device_authorization" "homepi4" {
  device_id  = "nnLYWS5CNTRL"
  authorized = true
}

resource "tailscale_device_key" "homepi4" {
  device_id           = "nnLYWS5CNTRL"
  key_expiry_disabled = true
}

# localhost (n1gZjU7CNTRL)
resource "tailscale_device_authorization" "localhost" {
  device_id  = "n1gZjU7CNTRL"
  authorized = true
}

resource "tailscale_device_key" "localhost" {
  device_id           = "n1gZjU7CNTRL"
  key_expiry_disabled = false
}

# nuc (n1NJvFqjKN11CNTRL)
resource "tailscale_device_authorization" "nuc" {
  device_id  = "n1NJvFqjKN11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "nuc" {
  device_id           = "n1NJvFqjKN11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "nuc" {
  device_id = "n1NJvFqjKN11CNTRL"
  tags      = ["tag:folly"]
}

# offsite-k8s-lan-router-0 (ntVg4yGs6A11CNTRL)
resource "tailscale_device_authorization" "offsite_k8s_lan_router_0" {
  device_id  = "ntVg4yGs6A11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "offsite_k8s_lan_router_0" {
  device_id           = "ntVg4yGs6A11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "offsite_k8s_lan_router_0" {
  device_id = "ntVg4yGs6A11CNTRL"
  tags      = ["tag:k8s", "tag:k8s-offsite", "tag:offsite"]
}

# oldboy (nzbfSZ6ntd11CNTRL)
resource "tailscale_device_authorization" "oldboy" {
  device_id  = "nzbfSZ6ntd11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "oldboy" {
  device_id           = "nzbfSZ6ntd11CNTRL"
  key_expiry_disabled = false
}

# oldschool (nAaXDo3CNTRL)
resource "tailscale_device_authorization" "oldschool" {
  device_id  = "nAaXDo3CNTRL"
  authorized = true
}

resource "tailscale_device_key" "oldschool" {
  device_id           = "nAaXDo3CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "oldschool" {
  device_id = "nAaXDo3CNTRL"
  tags      = ["tag:offsite"]
}

# optiplex (niJ7g4eXsK11CNTRL)
resource "tailscale_device_authorization" "optiplex" {
  device_id  = "niJ7g4eXsK11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "optiplex" {
  device_id           = "niJ7g4eXsK11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "optiplex" {
  device_id = "niJ7g4eXsK11CNTRL"
  tags      = ["tag:folly"]
}

# retrofit (nkKizV6CNTRL)
resource "tailscale_device_authorization" "retrofit" {
  device_id  = "nkKizV6CNTRL"
  authorized = true
}

resource "tailscale_device_key" "retrofit" {
  device_id           = "nkKizV6CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "retrofit" {
  device_id = "nkKizV6CNTRL"
  tags      = ["tag:offsite"]
}

# riptide (n2ZhP2n2VQ11CNTRL)
resource "tailscale_device_authorization" "riptide" {
  device_id  = "n2ZhP2n2VQ11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "riptide" {
  device_id           = "n2ZhP2n2VQ11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "riptide" {
  device_id = "n2ZhP2n2VQ11CNTRL"
  tags      = ["tag:folly"]
}

# rosie (n32cvVbP3m11CNTRL)
resource "tailscale_device_authorization" "rosie" {
  device_id  = "n32cvVbP3m11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "rosie" {
  device_id           = "n32cvVbP3m11CNTRL"
  key_expiry_disabled = false
}

# spore (nhbcso96nv11CNTRL)
resource "tailscale_device_authorization" "spore" {
  device_id  = "nhbcso96nv11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "spore" {
  device_id           = "nhbcso96nv11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "spore" {
  device_id = "nhbcso96nv11CNTRL"
  tags      = ["tag:folly"]
}

# tailscale-operator (nLfccVGfUU11CNTRL)
resource "tailscale_device_authorization" "tailscale_operator" {
  device_id  = "nLfccVGfUU11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "tailscale_operator" {
  device_id           = "nLfccVGfUU11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "tailscale_operator" {
  device_id = "nLfccVGfUU11CNTRL"
  tags      = ["tag:k8s-operator"]
}

# tailscale-operator (nTmt4W6mQg11CNTRL)
resource "tailscale_device_authorization" "tailscale_operator_ntmt4w6m" {
  device_id  = "nTmt4W6mQg11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "tailscale_operator_ntmt4w6m" {
  device_id           = "nTmt4W6mQg11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "tailscale_operator_ntmt4w6m" {
  device_id = "nTmt4W6mQg11CNTRL"
  tags      = ["tag:k8s-operator"]
}

# tailscale-operator (nmzwhS8hqf11CNTRL)
resource "tailscale_device_authorization" "tailscale_operator_nmzwhs8h" {
  device_id  = "nmzwhS8hqf11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "tailscale_operator_nmzwhs8h" {
  device_id           = "nmzwhS8hqf11CNTRL"
  key_expiry_disabled = true
}

resource "tailscale_device_tags" "tailscale_operator_nmzwhs8h" {
  device_id = "nmzwhS8hqf11CNTRL"
  tags      = ["tag:k8s-operator"]
}

# tallboy (nbMRvNYrak11CNTRL)
resource "tailscale_device_authorization" "tallboy" {
  device_id  = "nbMRvNYrak11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "tallboy" {
  device_id           = "nbMRvNYrak11CNTRL"
  key_expiry_disabled = true
}

# tinytower (nEMEVRWaMA21CNTRL)
resource "tailscale_device_authorization" "tinytower" {
  device_id  = "nEMEVRWaMA21CNTRL"
  authorized = true
}

resource "tailscale_device_key" "tinytower" {
  device_id           = "nEMEVRWaMA21CNTRL"
  key_expiry_disabled = false
}

# weatherpi4 (nhU6FwXLGs11CNTRL)
resource "tailscale_device_authorization" "weatherpi4" {
  device_id  = "nhU6FwXLGs11CNTRL"
  authorized = true
}

resource "tailscale_device_key" "weatherpi4" {
  device_id           = "nhU6FwXLGs11CNTRL"
  key_expiry_disabled = true
}
