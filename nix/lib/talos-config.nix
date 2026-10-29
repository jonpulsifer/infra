# Where an installed Talos node fetches its first config. fleet-controller (apps/fleet-controller)
# renders it on the anchor named here, under its state directory, and nginx serves it at
# /talos/config on the enrollment name's HTTPS server (../services/talos-enroll.nix). The other
# anchors pass that location to this anchor's plain-HTTP port on the Anchor network
# (../services/fleet-controller.nix).
{
  server = "spore";
  port = 8447;
  stateDir = "/var/lib/fleet-controller";
  # Its own directory under nginx's, so the controller's read access covers this log alone.
  logDir = "/var/log/nginx/fleet";
  log = "/var/log/nginx/fleet/talos-config.log";
}
