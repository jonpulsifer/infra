# folly's netboot iPXE, unsigned. Firmware PXE loads it from spore over TFTP, and its embedded
# script chains Smee's script for the booting MAC. Smee has none unless a Workflow allows the MAC to
# netboot, so a node with no Workflow, or one whose Workflow has finished, boots the signed Talos UKI
# through the script the image build writes from the UKI's own command line. .github/workflows/talos-images.yml signs it with
# the Talos UKI key: PCR 7 records each db certificate once, so a Talos UKI chained from it
# measures the same PCR 7 as a disk boot. The firmware verifies every image iPXE loads.
{
  ipxe,
  writeText,
}:
let
  lab = import ../lib/lab.nix;
  # Smee's HTTP listener (--http-port, Tinkerbell's default) on spore's bootstrap address. The DHCP
  # file and next-server name dnsmasq's TFTP, not Smee.
  script = writeText "folly-netboot.ipxe" ''
    #!ipxe
    dhcp || goto failed
    # The UKI's menu script sanboots the ISO, and sanboot takes no relative URL.
    set boot-url http://${lab.bootstrap.spore}/talos/folly
    chain http://${lab.bootstrap.spore}:7080/ipxe/script/''${net0/mac}/auto.ipxe || goto talos
    :talos
    chain ''${boot-url}/metal-amd64-secureboot-uki.ipxe || goto failed
    :failed
    echo folly netboot failed (''${errno}), back to the firmware
    exit 1
  '';
in
(ipxe.override {
  embedScript = script;
  enableDefaultPlatformTargets = false;
  additionalTargets = {
    "bin-x86_64-efi/ipxe.efi" = null;
  };
  firmwareBinary = "ipxe.efi";
}).overrideAttrs
  (old: {
    pname = "ipxe-folly";
    passthru = (old.passthru or { }) // {
      inherit script;
    };
  })
