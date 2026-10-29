# Where an installed Talos node fetches its first config, and where HookOS posts a machine's facts.
# fleet-controller (apps/fleet-controller) runs on the anchor named here. It renders the config
# under its state directory, and nginx serves it at /talos/config on the enrollment name's HTTPS
# server (../services/talos-boot.nix). The other anchors pass that location to this anchor's
# plain-HTTP port on the Anchor network (../services/fleet-controller.nix). Every anchor's
# enrollment name server passes intakePath to controllerPort on this anchor's Anchor address.
{
  server = "spore";
  port = 8447;
  # fleet-controller's webhook, /render and /intake port on the Anchor network.
  controllerPort = 8446;
  # The agent image (images/tink-agent-autoid) posts here, on the enrollment name.
  intakePath = "/fleet/intake";
  stateDir = "/var/lib/fleet-controller";
  # Its own directory under nginx's, so the controller's read access covers this log alone.
  logDir = "/var/log/nginx/fleet";
  log = "/var/log/nginx/fleet/talos-config.log";
}
