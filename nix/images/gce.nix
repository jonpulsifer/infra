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

  # No hostName here: mkHost sets the registry name, which nixos-upgrade needs
  # to find this host's flake output.
}
