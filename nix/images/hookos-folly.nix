# folly's generic HookOS, packed as one unsigned UKI for every node. Its command line carries no
# worker_id: the agent image derives the ID from the netbooted NIC's MAC, and the command line pins
# that image by digest, so the signature covers the agent that attests and wipes disks. The agent
# sets the clock from fleet_ntp_server and attests against fleet_attest_url before it waits for work
# (images/tink-agent-autoid). Under Secure Boot the stub ignores any command line iPXE passes, so
# ../services/fleetd.nix and ./ipxe-folly.nix pass this one. .github/workflows/talos-images.yml signs the UKI with the HookOS key, a db certificate apart
# from the Talos one, so a HookOS boot never measures Talos's PCR 7.
{
  lib,
  fetchurl,
  runCommand,
  systemdUkify,
}:
let
  lab = import ../lib/anchor.nix;
  fleet = import ../lib/fleet.nix;
  pins = lib.importJSON ../../clusters/folly/talos/netboot.json;
  # Tink server and syslog are Tinkerbell's on spore's bootstrap address, at its default ports;
  # chrony and fleetd's enrollment name answer there too.
  tink = lab.bootstrap.hosts.spore;
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
    # The Talos installer reads talos.platform from the host's /proc/cmdline before it touches the
    # disk, and dereferences a nil pointer when the argument is absent. HookOS ignores it.
    "talos.platform=metal"
    "tink_worker_image=${pins.tink_agent_image}"
    "fleet_attest_url=https://enroll.${fleet.dnsZone}/attest"
    "fleet_ntp_server=${tink}"
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
