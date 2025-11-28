{
  config,
  lib,
  pkgs,
  inputs,
  tags,
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

  services.tailscale = let
    tagsString = lib.concatStringsSep "," (lib.map (tag: "tag:${tag}") tags);
  in {
    enable = true;
    authKeyFile = "/var/secrets/tailscale-auth-key";
    extraUpFlags = [ "--advertise-tags=${tagsString}" ];
    extraSetFlags = [ "--accept-routes=true" ]
  };
}
