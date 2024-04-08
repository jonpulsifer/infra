{ lib, pkgs, config, ... }:

let
  inherit (pkgs.stdenv) isDarwin;
  inherit (lib) mkDefault mkIf optionals;
  inherit (config.lib.file) mkOutOfStoreSymlink;

  username = "jawn";
  homeDirectory = (if isDarwin then "/Users/" else "/home/") + username;
in
{
  imports = [
    ./basic.nix
    modules/go
    modules/gcloud
    modules/javascript
    modules/kubernetes
  ];

  home.packages = with pkgs;
    [
      _1password
      age
      gh
      postgresql_15
      terraform
    ] ++ optionals isDarwin [ ffmpeg reattach-to-user-namespace ];

  fonts.fontconfig.enable = true;

  # remove when https://github.com/nix-community/home-manager/issues/1341 is resolved
  disabledModules = [ "targets/darwin/linkapps.nix" ];
  home.activation = mkIf isDarwin {
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
        for appFile in ${apps}/Applications/*; do
          target="$baseDir/$(basename "$appFile")"
          $DRY_RUN_CMD cp ''${VERBOSE_ARG:+-v} -fHRL "$appFile" "$baseDir"
          $DRY_RUN_CMD chmod ''${VERBOSE_ARG:+-v} -R +w "$target"
        done
      '';
  };
}
