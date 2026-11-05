# A YubiKey whose PIV applet holds a key for a service on this host, reached through pcscd and
# ykcs11: spore's and capsule's DevID CA keys, forge's OpenBao unseal key. A setup script over ssh
# programs the card and stores its PIV secrets in the host's SOPS file. Members of the yubikey group
# may use the card and read its PIN.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.yubikey;
  provisioned = cfg.serial != null;
  pinSecret = "yubikey/piv-pin";
in
{
  options.homelab.yubikey = {
    enable = lib.mkEnableOption "the YubiKey that holds a key for a service on this host";

    serial = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.positive;
      default = null;
      description = ''
        The YubiKey's serial number. Set it once a setup script has stored the PIV secrets in
        this host's SOPS file: it declares the PIN secret, which sops-nix fails to find before then.
      '';
    };

    pkcs11Module = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${pkgs.yubico-piv-tool}/lib/libykcs11.so";
      description = "The ykcs11 PKCS#11 module.";
    };

    tokenLabel = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      readOnly = true;
      default = if provisioned then "YubiKey PIV #${toString cfg.serial}" else null;
      description = "The token label that ykcs11 gives the card.";
    };

    pinFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      readOnly = true;
      default = if provisioned then config.sops.secrets.${pinSecret}.path else null;
      description = "The PIV PIN, readable by the yubikey group.";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        services.pcscd.enable = true;
        # pcscd asks polkit before it lets a client use a reader or a card.
        security.polkit.enable = true;
        security.polkit.extraConfig = ''
          polkit.addRule(function(action, subject) {
            if ((action.id == "org.debian.pcsc-lite.access_pcsc" ||
                 action.id == "org.debian.pcsc-lite.access_card") &&
                (subject.user == "root" || subject.isInGroup("yubikey"))) {
              return polkit.Result.YES;
            }
          });
        '';
        services.udev.packages = [ pkgs.yubikey-personalization ];
        # pcscd runs as its own user; the Yubico rules admit only logged-in users.
        services.udev.extraRules = ''
          SUBSYSTEM=="usb", ATTR{idVendor}=="1050", GROUP="pcscd", MODE="0660"
        '';

        users.groups.yubikey = { };

        environment.systemPackages = [
          pkgs.opensc
          pkgs.openssl
          pkgs.yubico-piv-tool
          pkgs.yubikey-manager
        ];
        # A stable path for pkcs11-tool in the setup scripts, independent of the store path.
        environment.etc."yubikey/libykcs11.so".source = cfg.pkcs11Module;
      }
      (lib.mkIf provisioned {
        sops.secrets.${pinSecret} = {
          group = "yubikey";
          mode = "0440";
        };
      })
    ]
  );
}
