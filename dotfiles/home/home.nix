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
    modules/tidbyt
  ];

  home = {
    packages = with pkgs;
      [
        # cloudevents
        asciinema
        hugo
      ] ++ optionals isLinux [ wol ];

    shellAliases = {
      bruh = "${pkgs.fortune}/bin/fortune | ${pkgs.cowsay}/bin/cowsay -f moose | ${pkgs.lolcat}/bin/lolcat";
      paths = "echo \${PATH} | cut -f2 -d= | tr -s : \\\\n  | ${pkgs.lolcat}/bin/lolcat";
    };
  };

  xdg.configFile."systemd/user/cros-garcon.service.d/override.conf".source =
    modules/cros-garcon-override.conf;

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
