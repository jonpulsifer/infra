# forge: NVMe-rooted aarch64 build host. Runs `services.buildHost` (Nix remote
# builder, docker + buildx for native arm64 OCI, and harmonia for a local arm64
# binary cache fronted by nginx on the lab VLAN).
#
# Spore publishes the signed rackpi5 RAM image used by forge's EEPROM fallback.
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
    # sops-nix's default secret path; build-host's harmonia config reads from
    # here, fed by sops.secrets."harmonia-cache-key" below.
    binaryCacheSigningKeyPath = "/run/secrets/harmonia-cache-key";
  };

  sops.defaultSopsFile = ../secrets/forge.sops.yaml;
  # harmonia's binary-cache signing key. Public half is committed in the clear
  # at nix/secrets/forge-harmonia-cache.pub so clients can pin it in their
  # `trusted-public-keys`.
  sops.secrets."harmonia-cache-key" = { };
  sops.secrets."tailscale-auth-key" = { };

  services.tailscale = {
    authKeyFile = config.sops.secrets."tailscale-auth-key".path;
    authKeyParameters = {
      ephemeral = false;
      preauthorized = true;
    };
  };

  # Front harmonia (bound to 127.0.0.1:5000 by build-host.nix) on the lab VLAN
  # so the rest of the Pi fleet can pull from it without a new DNS record.
  # nginx is not in the fleet baseline -- only spore and forge run it today.
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

  # The NVMe is dedicated to root; no third partition (unlike spore, which
  # reserves the disk tail for /nfs/data). Standard sd-image expandOnBoot
  # grows the root to fill the disk on first boot.
  sdImage.expandOnBoot = true;
}
