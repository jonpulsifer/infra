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
    tagsString = lib.concatStringsSep "," (lib.mapAttrsToList (n: v: "tag:${n}") tags);
  in {
    enable = true;
    authKeyFile = "/var/secrets/tailscale-auth-key";
    extraUpFlags = [
      "--advertise-tags=${tagsString}"
      "--accept-routes=true"
    ];
  };
}
