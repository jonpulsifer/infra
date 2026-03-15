{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (pkgs.stdenv) isDarwin;
  package = if isDarwin then pkgs.emacsMacport else pkgs.emacs-nox;
in
{
  home = {
    file.".emacs.d/init.el".source = ./init.el;
    file.".emacs.d/lisp/ws-trim.el".source = ./ws-trim.el;
    shellAliases = {
      em = "${package}/bin/emacsclient";
    };
  };
  programs.emacs = {
    enable = true;
    inherit package;
  };
}
