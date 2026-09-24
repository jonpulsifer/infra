# forge: NVMe-rooted aarch64 build host: Nix remote builder, native arm64 OCI builds, and a
# harmonia cache for the Pi fleet. Its EEPROM falls back to the rackpi5 RAM image spore publishes.
{ config, ... }:
let
  fleet = import ../lib/fleet.nix;
  lab = import ../lib/lab.nix;
in
{
  imports = [
    ../profiles/pi5-nvme.nix
    ../services/build-host.nix
    ../system/sops.nix
  ];

  services.buildHost = {
    enable = true;
    ociBuilder = true;
    binaryCache = "harmonia";
    # sops-nix's default path for sops.secrets."harmonia-cache-key" below.
    binaryCacheSigningKeyPath = "/run/secrets/harmonia-cache-key";
  };

  sops.defaultSopsFile = ../secrets/forge.sops.yaml;
  # harmonia's signing key. Clients pin the public half, nix/secrets/forge-harmonia-cache.pub.
  sops.secrets."harmonia-cache-key" = { };
  sops.secrets."tailscale-auth-key" = { };

  services.tailscale = {
    authKeyFile = config.sops.secrets."tailscale-auth-key".path;
    authKeyParameters = {
      ephemeral = false;
      preauthorized = true;
    };
  };

  # Serves harmonia (127.0.0.1:5000, from build-host.nix) to the Pi fleet on the lab VLAN.
  services.nginx = {
    enable = true;
    virtualHosts."forge.${fleet.dnsZone}" = {
      listen = [
        {
          addr = lab.hosts.forge;
          port = 80;
        }
      ];
      locations."/".extraConfig = ''
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_redirect http:// https://;
        proxy_http_version 1.1;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
      '';
    };
  };

  # Root takes the whole NVMe; spore instead keeps the disk tail for /nfs/data.
  sdImage.expandOnBoot = true;
}
