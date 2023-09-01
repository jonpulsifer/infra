{ lib, pkgs, config, ... }:
let
  inherit (lib) mkForce mkIf mkMerge optionals;
  inherit (lib.attrsets) optionalAttrs;
  inherit (pkgs.stdenv) isLinux;
in
{
  imports = [
    ./default.nix
    modules/ssh
  ];

  home = {
    packages = with pkgs;
      [
        # cloudevents
        asciinema
        hugo

        # pixlet
        pixlet
        bazel-buildtools
      ] ++ optionals isLinux [ wol ];

    sessionVariables = {
      VAULT_ADDR = "https://vault.lolwtf.ca";
    };

    shellAliases = {
      bruh = "${pkgs.fortune}/bin/fortune | ${pkgs.cowsay}/bin/cowsay -f moose | ${pkgs.lolcat}/bin/lolcat";
      paths = "echo \${PATH} | cut -f2 -d= | tr -s : \\\\n  | ${pkgs.lolcat}/bin/lolcat";
    };
  };

  services.gpg-agent = mkIf isLinux {
    enable = false;
    pinentryFlavor = "tty";
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
