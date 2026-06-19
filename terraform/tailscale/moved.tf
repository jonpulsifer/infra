# ---------------------------------------------------------------------------
# Moved blocks — rename existing state entries to the new for_each addresses.
# These prevent destroy/create of live devices when the refactor is applied.
# Safe to remove once the plan shows zero changes.
# ---------------------------------------------------------------------------

# --- tailscale_device_authorization ---------------------------------------

moved {
  from = tailscale_device_authorization.device_800g2
  to   = tailscale_device_authorization.devices["800g2"]
}

moved {
  from = tailscale_device_authorization.atomic
  to   = tailscale_device_authorization.devices["atomic"]
}

moved {
  from = tailscale_device_authorization.chromebook_a288
  to   = tailscale_device_authorization.devices["chromebook-a288"]
}

moved {
  from = tailscale_device_authorization.cloudpi4
  to   = tailscale_device_authorization.devices["cloudpi4"]
}

moved {
  from = tailscale_device_authorization.craftbook_air
  to   = tailscale_device_authorization.devices["craftbook-air"]
}

moved {
  from = tailscale_device_authorization.desktop_g7i75ls
  to   = tailscale_device_authorization.devices["desktop-g7i75ls"]
}

moved {
  from = tailscale_device_authorization.folly_k8s_lan_router_0
  to   = tailscale_device_authorization.devices["folly-k8s-lan-router-0"]
}

moved {
  from = tailscale_device_authorization.folly_k8s_lan_router_0_npazfyuw
  to   = tailscale_device_authorization.devices["folly-k8s-lan-router-0-1"]
}

moved {
  from = tailscale_device_authorization.homepi4
  to   = tailscale_device_authorization.devices["homepi4"]
}

moved {
  from = tailscale_device_authorization.nuc
  to   = tailscale_device_authorization.devices["nuc"]
}

moved {
  from = tailscale_device_authorization.offsite_k8s_lan_router_0
  to   = tailscale_device_authorization.devices["offsite-k8s-lan-router-0"]
}

moved {
  from = tailscale_device_authorization.oldboy
  to   = tailscale_device_authorization.devices["oldboy"]
}

moved {
  from = tailscale_device_authorization.oldschool
  to   = tailscale_device_authorization.devices["oldschool"]
}

moved {
  from = tailscale_device_authorization.optiplex
  to   = tailscale_device_authorization.devices["optiplex"]
}

moved {
  from = tailscale_device_authorization.retrofit
  to   = tailscale_device_authorization.devices["retrofit"]
}

moved {
  from = tailscale_device_authorization.riptide
  to   = tailscale_device_authorization.devices["riptide"]
}

moved {
  from = tailscale_device_authorization.rosie
  to   = tailscale_device_authorization.devices["rosie"]
}

moved {
  from = tailscale_device_authorization.spore
  to   = tailscale_device_authorization.devices["spore"]
}

moved {
  from = tailscale_device_authorization.tailscale_operator_nmzwhs8h
  to   = tailscale_device_authorization.devices["tailscale-operator"]
}

moved {
  from = tailscale_device_authorization.tailscale_operator
  to   = tailscale_device_authorization.devices["tailscale-operator-1"]
}

moved {
  from = tailscale_device_authorization.tailscale_operator_ntmt4w6m
  to   = tailscale_device_authorization.devices["tailscale-operator-2"]
}

moved {
  from = tailscale_device_authorization.tallboy
  to   = tailscale_device_authorization.devices["tallboy"]
}

moved {
  from = tailscale_device_authorization.tinytower
  to   = tailscale_device_authorization.devices["tinytower"]
}

moved {
  from = tailscale_device_authorization.weatherpi4
  to   = tailscale_device_authorization.devices["weatherpi4"]
}

# --- tailscale_device_key -------------------------------------------------

moved {
  from = tailscale_device_key.device_800g2
  to   = tailscale_device_key.devices["800g2"]
}

moved {
  from = tailscale_device_key.atomic
  to   = tailscale_device_key.devices["atomic"]
}

moved {
  from = tailscale_device_key.chromebook_a288
  to   = tailscale_device_key.devices["chromebook-a288"]
}

moved {
  from = tailscale_device_key.cloudpi4
  to   = tailscale_device_key.devices["cloudpi4"]
}

moved {
  from = tailscale_device_key.craftbook_air
  to   = tailscale_device_key.devices["craftbook-air"]
}

moved {
  from = tailscale_device_key.desktop_g7i75ls
  to   = tailscale_device_key.devices["desktop-g7i75ls"]
}

moved {
  from = tailscale_device_key.folly_k8s_lan_router_0
  to   = tailscale_device_key.devices["folly-k8s-lan-router-0"]
}

moved {
  from = tailscale_device_key.folly_k8s_lan_router_0_npazfyuw
  to   = tailscale_device_key.devices["folly-k8s-lan-router-0-1"]
}

moved {
  from = tailscale_device_key.homepi4
  to   = tailscale_device_key.devices["homepi4"]
}

moved {
  from = tailscale_device_key.nuc
  to   = tailscale_device_key.devices["nuc"]
}

moved {
  from = tailscale_device_key.offsite_k8s_lan_router_0
  to   = tailscale_device_key.devices["offsite-k8s-lan-router-0"]
}

moved {
  from = tailscale_device_key.oldboy
  to   = tailscale_device_key.devices["oldboy"]
}

moved {
  from = tailscale_device_key.oldschool
  to   = tailscale_device_key.devices["oldschool"]
}

moved {
  from = tailscale_device_key.optiplex
  to   = tailscale_device_key.devices["optiplex"]
}

moved {
  from = tailscale_device_key.retrofit
  to   = tailscale_device_key.devices["retrofit"]
}

moved {
  from = tailscale_device_key.riptide
  to   = tailscale_device_key.devices["riptide"]
}

moved {
  from = tailscale_device_key.rosie
  to   = tailscale_device_key.devices["rosie"]
}

moved {
  from = tailscale_device_key.spore
  to   = tailscale_device_key.devices["spore"]
}

moved {
  from = tailscale_device_key.tailscale_operator_nmzwhs8h
  to   = tailscale_device_key.devices["tailscale-operator"]
}

moved {
  from = tailscale_device_key.tailscale_operator
  to   = tailscale_device_key.devices["tailscale-operator-1"]
}

moved {
  from = tailscale_device_key.tailscale_operator_ntmt4w6m
  to   = tailscale_device_key.devices["tailscale-operator-2"]
}

moved {
  from = tailscale_device_key.tallboy
  to   = tailscale_device_key.devices["tallboy"]
}

moved {
  from = tailscale_device_key.tinytower
  to   = tailscale_device_key.devices["tinytower"]
}

moved {
  from = tailscale_device_key.weatherpi4
  to   = tailscale_device_key.devices["weatherpi4"]
}

# --- tailscale_device_tags ------------------------------------------------

moved {
  from = tailscale_device_tags.device_800g2
  to   = tailscale_device_tags.devices["800g2"]
}

moved {
  from = tailscale_device_tags.desktop_g7i75ls
  to   = tailscale_device_tags.devices["desktop-g7i75ls"]
}

moved {
  from = tailscale_device_tags.folly_k8s_lan_router_0
  to   = tailscale_device_tags.devices["folly-k8s-lan-router-0"]
}

moved {
  from = tailscale_device_tags.folly_k8s_lan_router_0_npazfyuw
  to   = tailscale_device_tags.devices["folly-k8s-lan-router-0-1"]
}

moved {
  from = tailscale_device_tags.nuc
  to   = tailscale_device_tags.devices["nuc"]
}

moved {
  from = tailscale_device_tags.offsite_k8s_lan_router_0
  to   = tailscale_device_tags.devices["offsite-k8s-lan-router-0"]
}

moved {
  from = tailscale_device_tags.oldschool
  to   = tailscale_device_tags.devices["oldschool"]
}

moved {
  from = tailscale_device_tags.optiplex
  to   = tailscale_device_tags.devices["optiplex"]
}

moved {
  from = tailscale_device_tags.retrofit
  to   = tailscale_device_tags.devices["retrofit"]
}

moved {
  from = tailscale_device_tags.riptide
  to   = tailscale_device_tags.devices["riptide"]
}

moved {
  from = tailscale_device_tags.spore
  to   = tailscale_device_tags.devices["spore"]
}

moved {
  from = tailscale_device_tags.tailscale_operator_nmzwhs8h
  to   = tailscale_device_tags.devices["tailscale-operator"]
}

moved {
  from = tailscale_device_tags.tailscale_operator
  to   = tailscale_device_tags.devices["tailscale-operator-1"]
}

moved {
  from = tailscale_device_tags.tailscale_operator_ntmt4w6m
  to   = tailscale_device_tags.devices["tailscale-operator-2"]
}
