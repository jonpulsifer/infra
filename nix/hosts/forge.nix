# forge: NVMe-rooted aarch64 build host: Nix remote builder, native arm64 OCI builds, and a
# harmonia cache for the Pi fleet, and one of the three anchors that run the lab's DNS and NTP. Its EEPROM falls back to the rackpi5 RAM image spore publishes.
# It runs OpenBao, the lab's online CA, sealed by the YubiKey in its USB port.
{ config, ... }:
let
  fleet = import ../lib/fleet.nix;
  lab = import ../lib/anchor.nix;
in
{
  imports = [
    ../profiles/anchor.nix
    ../profiles/pi5-nvme.nix
    ../services/build-host.nix
    ../services/garage.nix
    ../services/openbao.nix
    ../system/sops.nix
  ];

  # The YubiKey 5C that holds OpenBao's unseal key in slot 9d, programmed by
  # `mise run openbao:yubikey:init forge`.
  homelab.yubikey.enable = true;
  homelab.yubikey.serial = 34074538;
  homelab.openbao.enable = true;
  # The PKI that git declares, with the token `mise run openbao:config-token forge` stores.
  homelab.openbao.pki.enable = true;

  services.buildHost = {
    enable = true;
    ociBuilder = true;
    binaryCache = "harmonia";
    # sops-nix's default path for sops.secrets."harmonia-cache-key" below.
    binaryCacheSigningKeyPath = "/run/secrets/harmonia-cache-key";
  };

  homelab.garage = {
    enable = true;
    site = "folly";
    dataDir = "/var/lib/garage";
    clustered = true;
    bootstrap = false;
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
