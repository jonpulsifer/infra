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

  # Move an existing file aside where home-manager wants its symlink. Without this, home-manager
  # refuses to clobber it and nixos-rebuild switch fails.
  home-manager.backupFileExtension = "hm-bak";
  home-manager.users.jawn = lib.mkIf (config.homelab.fleet.homeManager) (
    import ../home/jawn.nix
  );
}