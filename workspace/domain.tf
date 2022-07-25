resource "googleworkspace_domain" "pulsifer_ca" {
  domain_name = "pulsifer.ca"
}

resource "googleworkspace_domain_alias" "pulsifer_dev" {
  parent_domain_name = googleworkspace_domain.pulsifer_ca.domain_name
  domain_alias_name  = "pulsifer.dev"
}
