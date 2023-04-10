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

    modules/gcloud
    modules/go
    modules/kubernetes
    modules/node
    modules/tmux
  ];

  home.sessionVariables = {
    VAULT_ADDR = "https://vault.lolwtf.ca";
  };

  home.packages = with pkgs;
    [

      # cloudflare
      # flarectl
      # wrangler

      # cloud things
      # conftest
      # cosign
      # hadolint
      # infracost
      # open-policy-agent
      # rekor-cli
      # trivy

      # hashicorp
      terraform
      # terraform-docs
      # terraformer
      # tflint
      # tfsec

      # things i use
      _1password
      age
      dnstwist
      gh
      gptcommit
      sops
      vault

    ] ++ optionals isDarwin [ reattach-to-user-namespace ];

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
