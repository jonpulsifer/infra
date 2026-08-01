# oldboy: a Google Compute Engine instance. The image module supplies the disk
# layout and takes the hostname from GCE metadata rather than from the flake,
# so this host declares nothing of its own beyond the fleet baseline.
{ ... }:
{
  imports = [ ../images/gce.nix ];
}
