# folly's generic HookOS, packed as one unsigned UKI for every node. Its command line carries no
# worker_id: the agent image derives the ID from the netbooted NIC's MAC, and the command line pins
# that image by digest, so the signature covers the agent that wipes disks. Under Secure Boot the
# stub ignores any command line iPXE passes. .github/workflows/talos-images.yml signs the UKI with
# the HookOS key, a db certificate apart from the Talos one, so a HookOS boot never measures
# Talos's PCR 7.
{
  lib,
  fetchurl,
  runCommand,
  systemdUkify,
}:
let
  lab = import ../lib/lab.nix;
  pins = lib.importJSON ../../clusters/folly/talos/netboot.json;
  # Tink server and syslog are Tinkerbell's on spore's bootstrap address, at its default ports.
  tink = lab.bootstrap.spore;
  cmdline = lib.concatStringsSep " " [
    "facility="
    "syslog_host=${tink}"
    "grpc_authority=${tink}:42113"
    "tinkerbell_tls=false"
    "tinkerbell_insecure_tls=false"
    "modules=loop,squashfs,sd-mod,usb-storage"
    "intel_iommu=on"
    "iommu=pt"
    "console=ttyS0,115200"
    "console=tty0"
    "tink_worker_image=${pins.tink_agent_image}"
  ];
  tarball = fetchurl {
    url = "https://github.com/tinkerbell/hook/releases/download/${pins.hookos.version}/hook_latest-lts-x86_64.tar.gz";
    inherit (pins.hookos) sha512;
  };
  ukify = systemdUkify.out;
in
runCommand "hookos-folly-uki"
  {
    passthru = { inherit cmdline; };
  }
  ''
    tar -xzf ${tarball} vmlinuz-latest-lts-x86_64 initramfs-latest-lts-x86_64
    mkdir -p $out
    ${ukify}/bin/ukify build \
      --linux=vmlinuz-latest-lts-x86_64 \
      --initrd=initramfs-latest-lts-x86_64 \
      --stub=${ukify}/lib/systemd/boot/efi/linuxx64.efi.stub \
      --uname=hookos-${pins.hookos.version} \
      --os-release='ID=hookos' \
      --cmdline=${lib.escapeShellArg cmdline} \
      --output=$out/hookos.efi
  ''
