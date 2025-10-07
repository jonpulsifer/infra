{ config, lib, pkgs, ... }:
let 
  terraformPluginCacheDir = config.home.homeDirectory + "/.terraform.d/plugin-cache";
in
{
  home.packages = with pkgs; [
    tenv
  ];

  home.sessionPath = [ "${config.home.homeDirectory}/.tenv/bin" ];

  # sick of downloading providers all the time? do this!
  home.file.".terraformrc".text = ''
    plugin_cache_dir = "${terraformPluginCacheDir}"
  '';

  # This directory must already exist before Terraform will cache plugins; Terraform will not create the directory itself.
  home.activation.name = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    mkdir -p ${terraformPluginCacheDir}
  '';
}
