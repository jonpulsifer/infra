{
  lib,
  ...
}:
{
  services.tailscale.enable = lib.mkForce false;
}
