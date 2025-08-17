{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkIf;
  inherit (pkgs.stdenv) isDarwin;
in
{
  home.homeDirectory = "/Users/${config.home.username}";
  home.packages = with pkgs; [
    reattach-to-user-namespace
  ];

  fonts.fontconfig.enable = true;

  programs.ghostty = {
    enable = true;
    enableZshIntegration = true;
    installBatSyntax = mkIf (config.programs.ghostty.package != null) true;
    settings = {
      background-blur = true;
      background-opacity = 0.9;
      bold-is-bright = true;
      font-family = "CaskaydiaCove Nerd Font";
      font-size = 12;
      font-thicken = false;
      theme = "Argonaut";
    };
  };

  # remove when https://github.com/nix-community/home-manager/issues/1341 is resolved
  disabledModules = [ "targets/darwin/linkapps.nix" ];
  home.activation = {
    copyApplications =
      let
        apps = pkgs.buildEnv {
          name = "home-manager-applications";
          paths = config.home.packages;
          pathsToLink = "/Applications";
        };

      in
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        baseDir="$HOME/Applications/Home Manager Apps"
        if [ -d "$baseDir" ]; then
          rm -rf "$baseDir"
        fi
        mkdir -p "$baseDir"
        if [ ! -d "${apps}/Applications/" ]; then
          for appFile in ${apps}/Applications/*; do
            target="$baseDir/$(basename "$appFile")"
            $DRY_RUN_CMD cp ''${VERBOSE_ARG:+-v} -fHRL "$appFile" "$baseDir"
            $DRY_RUN_CMD chmod ''${VERBOSE_ARG:+-v} -R +w "$target"
          done
        fi
      '';
  };
}
