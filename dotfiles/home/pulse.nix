# Minimal container profile: zsh + git, smallest closure possible.
{
  lib,
  config,
  ...
}:
{
  imports = [
    modules/git.nix
    modules/zsh.nix
  ];

  home = {
    username = "pulse";
    homeDirectory = "/home/${config.home.username}";
    stateVersion = "25.11";
    sessionVariables = {
      LANG = "en_US.UTF-8";
      LC_ALL = "en_US.UTF-8";
    };
  };

  programs.gh.enable = lib.mkForce false;
  programs.git.signing.signByDefault = lib.mkForce false;
  programs.home-manager.enable = true;
  programs.command-not-found.enable = false;
  programs.fzf.enable = true;
  manual.manpages.enable = false;
  xdg.enable = true;
}
