# tink-lab's netboot iPXE: the embedded script of nix/images/ipxe-folly.nix, with the namespace's
# boot server for spore and tink-lab's HookOS command line, unsigned. dnsmasq serves it over TFTP,
# where Smee's proxy offer names it.
{
  ipxe,
  writeText,
  boot,
  site,
  cmdline,
}:
let
  script = writeText "tink-lab-netboot.ipxe" ''
    #!ipxe
    dhcp || goto failed
    set boot-url http://${boot}/talos/${site}
    chain http://${boot}:7080/ipxe/script/''${net0/mac}/auto.ipxe || goto menu
    :menu
    menu tink-lab netboot
    item hookos Boot HookOS, attest and wait for a Workflow
    item exit Back to the firmware
    choose --timeout 10000 --default hookos target || set target hookos
    goto ''${target}
    :hookos
    imgfree
    chain --autofree ''${boot-url}/hookos-amd64-secureboot-uki.efi ${cmdline} || goto failed
    exit 1
    :exit
    exit 1
    :failed
    echo tink-lab netboot failed (''${errno}), back to the firmware
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
  (_: {
    pname = "ipxe-tink-lab";
  })
