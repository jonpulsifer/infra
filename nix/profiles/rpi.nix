{ config, inputs, ... }:
{
  imports = [
    "${inputs.nixpkgs}/nixos/modules/installer/sd-card/sd-image-aarch64.nix"
    ../hardware/pi4
    ../profiles/server.nix
  ];

  sdImage.compressImage = true;
  sdImage.firmwareSize = 512;
}
