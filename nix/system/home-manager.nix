{
  config,
  lib,
  inputs,
  ...
}:
{
  imports = [ inputs.home-manager.nixosModules.home-manager ];

  home-manager.useGlobalPkgs = true;
  home-manager.useUserPackages = true;
  home-manager.users.jawn = lib.mkIf (config.homelab.fleet.homeManager) (
    import ../home/jawn.nix
  );
}