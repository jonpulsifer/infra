{
  lib,
  pkgs,
  config,
  ...
}:
let
  inherit (pkgs.stdenv) isLinux isDarwin;
in
{
  imports = [
    ./basic.nix
    modules/gcloud.nix
    modules/go.nix
    modules/javascript.nix
    modules/kubernetes.nix
    modules/opencode
    modules/ssh.nix
    modules/terraform.nix
  ];

  home = rec {
    packages =
      with pkgs;
      [
        _1password-cli
        age
        postgresql
        sops
        vault
      ]
      ++ (with pkgs.unstable; [
        conftest
      ])
      ++ lib.optionals isLinux [ wol ]
      ++ lib.optionals isDarwin [ ];

    sessionVariables = {
      EDITOR = "cursor";
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

  programs.gpg = lib.mkIf isLinux {
    enable = true;
    settings = {
      personal-cipher-preferences = "AES256 AES192 AES";
      personal-digest-preferences = "SHA512 SHA384 SHA256";
      personal-compress-preferences = "ZLIB BZIP2 ZIP Uncompressed";
      default-preference-list = "SHA512 SHA384 SHA256 AES256 AES192 AES ZLIB BZIP2 ZIP Uncompressed";
      cert-digest-algo = "SHA512";
      s2k-digest-algo = "SHA512";
      s2k-cipher-algo = "AES256";
      charset = "utf-8";
      fixed-list-mode = true;
      no-comments = true;
      no-emit-version = true;
      keyid-format = "0xlong";
      list-options = "show-uid-validity";
      verify-options = "show-uid-validity";
      with-fingerprint = true;
      require-cross-certification = true;
      no-symkey-cache = true;
      use-agent = true;
      throw-keyids = true;
    };
  };
}
