{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
{
  environment.systemPackages = with pkgs; [
    tailscale
  ];

  # dnssec = false is required for tailscale to work
  services.resolved = {
    enable = true;
    dnssec = "false";
  };

  services.tailscale = {
    enable = true;
    authKeyFile = "/var/secrets/tailscale-auth-key";
  };
}
