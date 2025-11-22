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
}
