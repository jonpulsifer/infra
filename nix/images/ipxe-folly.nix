# folly's netboot iPXE, unsigned. Firmware PXE loads it from spore over TFTP, and its embedded
# script chains Smee's script for the booting MAC. Smee has none unless a Workflow allows the MAC to
# netboot, so a node with no Workflow, or one whose Workflow has finished, gets the menu below, from
# spore's bootstrap address. Its default boots HookOS as a Hardware's script does (apps/fleetd),
# which attests and waits for a Workflow.
# .github/workflows/talos-images.yml signs iPXE with the Talos UKI key. The firmware verifies every
# image iPXE loads.
{
  callPackage,
  ipxe,
  writeText,
}:
let
  lab = import ../lib/anchor.nix;
  spore = lab.bootstrap.hosts.spore;
  hookos = callPackage ./hookos-folly.nix { };
  # Smee's HTTP listener (--http-port, Tinkerbell's default) on spore's bootstrap address. The DHCP
  # file and next-server name dnsmasq's TFTP, not Smee.
  #
  # sanboot takes no relative URL, so the script sets boot-url. imgfree runs before the HookOS chain:
  # iPXE serves the initrd of any other loaded image to systemd-stub, which then refuses its own.
  # Under Secure Boot the stub keeps HookOS's signed command line; without it the stub takes iPXE's
  # arguments, so the chain passes the same one. The enroll item sanboots the signed ISO, whose
  # systemd-boot enrolls the lab's Secure Boot keys on firmware in Setup Mode.
  script = writeText "folly-netboot.ipxe" ''
    #!ipxe
    dhcp || goto failed
    set boot-url http://${spore}/talos/folly
    chain http://${spore}:7080/ipxe/script/''${net0/mac}/auto.ipxe || goto menu
    :menu
    menu folly netboot
    item hookos Boot HookOS, attest and wait for a Workflow
    item enroll Enroll the lab's Secure Boot keys (firmware in Setup Mode)
    item exit Back to the firmware
    choose --timeout 10000 --default hookos target || set target hookos
    goto ''${target}
    :hookos
    imgfree
    chain --autofree ''${boot-url}/hookos-amd64-secureboot-uki.efi ${hookos.cmdline} || goto failed
    exit 1
    :enroll
    sanboot --no-describe ''${boot-url}/metal-amd64-secureboot.iso || goto failed
    :exit
    exit 1
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
