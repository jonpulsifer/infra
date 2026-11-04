# folly's own RAM boot image, unsigned: a kernel and a NixOS systemd initrd packed as one UKI, which
# .github/workflows/talos-images.yml signs with the HookOS key and publishes beside HookOS. The
# initrd is the system. It never mounts a root or switches to one: its command line makes
# fleet-boot.target the initrd's default unit, so none of NixOS's stage-2 units run, and the target
# pulls in udev, which loads each NIC, disk and TPM driver by its modalias, networkd's DHCP,
# resolved, and fleet-boot (apps/fleetd/cmd/fleet-boot), which sets the clock, attests and runs
# what fleetd answers. The command line names the same fleetd, NTP server and syslog receiver as
# HookOS's (./hookos-folly.nix), and the signature covers it and the fleet-boot binary. No
# container runtime: the tools the steps run are in the initrd's /bin. netboot.json pins the
# kernel series, so a nixpkgs bump moves the image's kernel only within it.
{
  lib,
  nixos,
  callPackage,
  runCommand,
  systemdUkify,
}:
let
  lab = import ../lib/anchor.nix;
  fleet = import ../lib/fleet.nix;
  pins = lib.importJSON ../../clusters/folly/talos/netboot.json;
  spore = lab.bootstrap.hosts.spore;
  # The words any image that runs fleet-boot takes, which the Alpine image
  # (../../images/fleet-boot-alpine) bakes as its whole command line.
  bootCmdline = lib.concatStringsSep " " [
    "syslog_host=${spore}"
    "fleet_attest_url=https://enroll.${fleet.dnsZone}/attest"
    "fleet_ntp_server=${spore}"
    "intel_iommu=on"
    "iommu=pt"
    "console=ttyS0,115200"
    "console=tty0"
  ];
  cmdline = "rd.systemd.unit=fleet-boot.target " + bootCmdline;

  # The fleetd module's own build, so the vendor hash is package.nix's; static, with no cgo.
  fleetBoot = (callPackage ../../apps/fleetd/package.nix { }).overrideAttrs (old: {
    pname = "fleet-boot";
    subPackages = [ "cmd/fleet-boot" ];
    env = (old.env or { }) // {
      CGO_ENABLED = "0";
    };
    ldflags = [
      "-s"
      "-w"
    ];
    doCheck = false;
    meta = old.meta // {
      description = "Attests a machine from the lab's RAM boot image and runs the boot fleetd answers";
      mainProgram = "fleet-boot";
    };
  });

  system =
    (nixos (
      { pkgs, ... }:
      {
        system.stateVersion = lib.trivial.release;
        networking.hostName = "fleet-boot";
        boot.loader.grub.enable = false;
        boot.kernelPackages = pkgs.${pins.fleet_boot.kernel};
        # NixOS requires a root file system; the initrd never mounts it.
        fileSystems."/" = {
          device = "none";
          fsType = "tmpfs";
        };
        hardware.enableRedistributableFirmware = true;

        boot.initrd = {
          compressor = "zstd";
          # The lab's NICs: Intel on every node, Realtek and USB adapters on spares; its disks: NVMe,
          # SATA and USB; the file systems an install mounts to write a seed. udev loads each by
          # modalias, so the list only decides what the initrd carries.
          availableKernelModules = [
            "e1000e"
            "igb"
            "igc"
            "r8169"
            "tg3"
            "r8152"
            "ax88179_178a"
            "cdc_ether"
            "nvme"
            "ahci"
            "sd_mod"
            "usb_storage"
            "uas"
            "xhci_pci"
            "vfat"
            "nls_cp437"
            "nls_iso8859_1"
            "ext4"
          ];
          # The TPM's drivers and efivarfs load whatever udev finds.
          kernelModules = [
            "tpm_tis"
            "tpm_crb"
            "efivarfs"
          ];
          systemd = {
            enable = true;
            tpm2.enable = false;
            network = {
              enable = true;
              wait-online.enable = false;
              networks."10-ether" = {
                matchConfig.Type = "ether";
                networkConfig.DHCP = "ipv4";
                dhcpV4Config.ClientIdentifier = "mac";
              };
            };
            initrdBin = [
              pkgs.gptfdisk
              pkgs.util-linux
              pkgs.xz
              pkgs.zstd
              pkgs.gzip
              pkgs.gnutar
              pkgs.efibootmgr
              pkgs.nvme-cli
            ];
            storePaths = [
              "${fleetBoot}/bin/fleet-boot"
              "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
            targets.fleet-boot = {
              description = "fleet-boot";
              requires = [ "basic.target" ];
              after = [ "basic.target" ];
              wants = [
                "fleet-boot.service"
                "systemd-networkd.service"
                "systemd-networkd.socket"
              ];
              unitConfig.AllowIsolate = true;
            };
            services.fleet-boot = {
              description = "attest and run the boot fleetd answers";
              after = [
                "basic.target"
                "systemd-networkd.service"
                "systemd-resolved.service"
              ];
              environment.SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
              serviceConfig = {
                Type = "simple";
                ExecStart = "${fleetBoot}/bin/fleet-boot";
                StandardOutput = "journal";
                Restart = "no";
              };
            };
          };
        };
      }
    )).config;

  kernel = "${system.system.build.kernel}/${system.system.boot.loader.kernelFile}";
  initrd = "${system.system.build.initialRamdisk}/${system.system.boot.loader.initrdFile}";
  ukify = systemdUkify.out;
in
runCommand "fleet-boot-uki"
  {
    passthru = {
      inherit cmdline bootCmdline fleetBoot;
      # The initrd's NixOS configuration, for nix/lib/checks.nix.
      config = system;
      kernelVersion = system.boot.kernelPackages.kernel.version;
    };
  }
  ''
    mkdir -p $out
    ${ukify}/bin/ukify build \
      --linux=${kernel} \
      --initrd=${initrd} \
      --stub=${ukify}/lib/systemd/boot/efi/linuxx64.efi.stub \
      --uname=${system.boot.kernelPackages.kernel.modDirVersion} \
      --os-release='ID=fleet-boot' \
      --cmdline=${lib.escapeShellArg cmdline} \
      --output=$out/fleet-boot.efi
  ''
