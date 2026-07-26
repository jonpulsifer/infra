# forge: aarch64 build host. The former rackpi5, but now self-booting off
# its installed NVMe (256 GB Patriot P300) instead of HTTP-booting a signed
# image from spore. Runs `services.buildHost` (Nix remote builder, docker +
# buildx for native arm64 OCI, harmonia for a local arm64 binary cache
# fronted by nginx on the lab VLAN).
#
# The old rackpi5 native-boot chain stays in place on spore (still
# publishing, harmless) as a fallback -- spore's role is unchanged.
#
# First-boot deployment is a live install over the running rackpi5 RAM
# image: build the sdImage on spore, dd it to /dev/nvme0n1 on the box
# itself, set EEPROM BOOT_ORDER=0xf416, reboot. The old netboot path
# remains in EEPROM as a secondary entry, so a failed install falls back
# to spore's signed image rather than bricking.
{
  config,
  lib,
  name,
  ...
}:
let
  lab =
    (builtins.fromJSON (builtins.readFile ../../terraform/network/unifi/folly/lab.tf.json)).locals.lab;
in
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
    ../services/common.nix
    ../services/build-host.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce false;
  };

  services.buildHost = {
    enable = true;
    ociBuilder = true;
    binaryCache = "harmonia";
    # sops-nix's default secret path; build-host's harmonia config
    # reads from here. The forge sops file is wired in flake.nix
    # (nix/secrets/forge.sops.yaml + sops.secrets."harmonia-cache-key").
    binaryCacheSigningKeyPath = "/run/secrets/harmonia-cache-key";
  };

  # Front harmonia (bound to 127.0.0.1:5000 by build-host.nix) on the lab
  # VLAN so the rest of the Pi fleet can pull via http://forge.lolwtf.ca
  # without a new DNS record. nginx is not in common.nix -- only spore and
  # forge run it today.
  services.nginx = {
    enable = true;
    virtualHosts."forge.lolwtf.ca" = {
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
