{
  config,
  lib,
  modulesPath,
  inputs,
  ...
}:
{
  imports = [
    (modulesPath + "/virtualisation/google-compute-image.nix")
  ];

  virtualisation = {
    googleComputeImage = {
      efi = true;
      contents = [
        {
          source = "${inputs.self.outPath}/flake.nix";
          target = "/etc/nixos/flake.nix";
          mode = "0644";
          user = "root";
          group = "root";
        }
      ];
    };
  };

  # No hostname override: mkHost defaults it to the registry name. An empty
  # hostname here was meant to let GCE metadata name the instance, but nothing
  # in a NixOS guest consumes it -- the kernel's built-in "nixos" is what
  # sticks, and nixos-upgrade then resolves nixosConfigurations."nixos", which
  # does not exist, so every GCE host silently stopped self-upgrading. Each
  # cloud host builds its own image from its own closure, so the baked name is
  # correct from first boot.
}
