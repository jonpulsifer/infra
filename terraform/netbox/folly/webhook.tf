# Wakes fleet-controller on spore on every device update. NetBox conditions see
# only the new state, not the change, so the rule cannot filter on a status
# change; the controller ignores updates that need nothing. 8446 is
# controllerPort in nix/lib/talos-config.nix.
#
# The provider has no field for the webhook's secret, the value the controller
# verifies (the 1Password item `fleet-controller webhook secret`), so Terraform
# leaves it as NetBox holds it. A NetBox without it sends unsigned webhooks,
# which the controller refuses, and it reconciles on its poll alone.
resource "netbox_webhook" "fleet_controller" {
  name              = "fleet-controller"
  payload_url       = "http://${local.anchor_topology.SPORE_IP}:8446/webhook"
  http_method       = "POST"
  http_content_type = "application/json"
}

resource "netbox_event_rule" "fleet_controller" {
  name             = "fleet-controller-device-update"
  description      = "A device changed; the controller reconciles on desired_action and status"
  content_types    = ["dcim.device"]
  event_types      = ["object_updated"]
  enabled          = true
  action_type      = "webhook"
  action_object_id = netbox_webhook.fleet_controller.id
  tags             = [local.managed_tag]
}
