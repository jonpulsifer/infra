{ config, lib, pkgs, ... }:
let
  inherit (pkgs.stdenv) isDarwin;
  enabled = lib.mkIf (config.programs.emacs.enable);
in
{
  home = (enabled) {
    file.".emacs.d/init.el".source = ./init.el;
    file.".emacs.d/lisp/ws-trim.el".source = ./ws-trim.el;
    shellAliases = {
      em = "${config.programs.emacs.package}/bin/emacsclient";
    };
  };

  xdg.dataFile."applications/emacs.desktop".source = (enabled) ./emacs.desktop;

  programs.emacs = {
    enable = true;
    package = if isDarwin then pkgs.emacsMacport else pkgs.emacs;
  };
}
