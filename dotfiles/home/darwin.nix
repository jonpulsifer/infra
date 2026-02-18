{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkIf;
  inherit (pkgs.stdenv) isDarwin isLinux;
in
{
  home.homeDirectory = "/Users/${config.home.username}";
  home.packages = with pkgs; [
    reattach-to-user-namespace
  ];

  fonts.fontconfig.enable = true;

  programs.ghostty =
    let
      macosBinds = {
        keybind = "global:cmd+backquote=toggle_quick_terminal";
      };
    in
    {
      enable = isDarwin;
      package = if isDarwin then null else pkgs.ghostty;
      enableZshIntegration = true;
      installBatSyntax = mkIf (isLinux) true;
      settings = {
        background-blur = true;
        background-opacity = 0.9;
        bold-is-bright = true;
        font-family = "CaskaydiaCove Nerd Font";
        font-size = 12;
        font-thicken = false;
        theme = "Argonaut";
      }
      // lib.optionalAttrs isDarwin macosBinds;
    };

  targets.darwin.linkApps.enable = false;
  targets.darwin.copyApps.enable = true;
}
