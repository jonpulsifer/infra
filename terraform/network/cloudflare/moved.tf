# Address renames from spindrift to kthx_engine. State moves; nothing is replaced.

moved {
  from = module.tunnel_spindrift
  to   = module.tunnel_kthx_engine
}

moved {
  from = cloudflare_dns_record.spindrift_apps_wildcard
  to   = cloudflare_dns_record.kthx_engine_apps_wildcard
}

moved {
  from = onepassword_item.spindrift_cloudflared
  to   = onepassword_item.kthx_engine_cloudflared
}
