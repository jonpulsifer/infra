{
  lib,
  pkgs,
  config,
  ...
}:
let
  inherit (pkgs.stdenv) isLinux;
in
{
  imports = [
    ./default.nix
    modules/go
    modules/ssh
  ];

  home = rec {
    packages =
      with pkgs;
      [
        # cloudevents
        # asciinema
        # hugo
        sops
        vault

        # pixlet
        # bazel-buildtools
      ]
      ++ lib.optionals isLinux [ wol ];

    sessionVariables = {
      VAULT_ADDR = "https://vault.lolwtf.ca";
    };
  };

  services.gpg-agent = lib.mkIf isLinux {
    enable = false;
    defaultCacheTtl = 86400;
    maxCacheTtl = 7200;
    enableExtraSocket = true;

    enableSshSupport = true;
    maxCacheTtlSsh = 7200;
    sshKeys = [ "3BF5FE568B9965E185EB48887269D6494CD87EC5" ];

    extraConfig = ''
      allow-loopback-pinentry
    '';
  };
}
