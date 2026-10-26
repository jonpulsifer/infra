# folly's netboot iPXE, unsigned. Firmware PXE loads it from spore over TFTP, and its embedded
# script chains Smee's script for the booting MAC. .github/workflows/talos-images.yml signs it with
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
    chain http://${lab.bootstrap.spore}:7080/ipxe/script/''${net0/mac}/auto.ipxe || goto failed
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
