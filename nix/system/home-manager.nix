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

  # Hosts still carry real files where home-manager now wants its own symlinks —
  # ~/.config/zsh/.zshrc predates these being managed here. Without a backup
  # extension home-manager refuses to clobber them, and because activation is
  # part of the switch, that one refusal fails the entire nixos-rebuild: an
  # unrelated chrony change cannot land while a stale dotfile sits in the way.
  # Move the file aside instead. Only ever happens once per file, since what
  # replaces it is a symlink home-manager owns.
  home-manager.backupFileExtension = "hm-bak";
  home-manager.users.jawn = lib.mkIf (config.homelab.fleet.homeManager) (
    import ../home/jawn.nix
  );
}