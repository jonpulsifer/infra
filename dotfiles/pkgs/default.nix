{
  pkgs ? import <nixpkgs> { },
}:
{
  # kubectl = import ./kubectl.nix { };
  # pixlet = import ./pixlet.nix { };
  shell-utils = import ./shell-utils.nix { pkgs = pkgs; };
}
