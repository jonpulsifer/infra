# A YubiKey that holds a hardware DevID CA key in a PIV slot, reached through pcscd and ykcs11.
# scripts/devid-ca-yubikey.sh initializes the key over ssh; members of the talos-attest group may
# use the card and read its PIN (docs/runbooks/set-up-a-devid-ca-yubikey.md).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.devidCa.yubikey;
  provisioned = cfg.serial != null;
  pinSecret = "devid-ca/piv-pin";
in
{
  options.homelab.devidCa.yubikey = {
    enable = lib.mkEnableOption "the YubiKey that holds this host's DevID CA key";

    slot = lib.mkOption {
      type = lib.types.enum [
        "9a"
        "9c"
        "9d"
        "9e"
      ];
      default = "9c";
      description = "The PIV slot of the CA key. scripts/devid-ca-yubikey.sh reads it.";
    };

    serial = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.positive;
      default = null;
      description = ''
        The YubiKey's serial number. Set it once `devid:yubikey:init` has stored the PIV secrets in
        this host's SOPS file: it declares the PIN secret, which sops-nix fails to find before then.
      '';
    };

    pkcs11Module = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${pkgs.yubico-piv-tool}/lib/libykcs11.so";
      description = "The ykcs11 PKCS#11 module, for ATTEST_CA_PKCS11_MODULE.";
    };

    tokenLabel = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      readOnly = true;
      default = if provisioned then "YubiKey PIV #${toString cfg.serial}" else null;
      description = "The token label that ykcs11 gives the key, for ATTEST_CA_PKCS11_TOKEN.";
    };

    pinFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      readOnly = true;
      default = if provisioned then config.sops.secrets.${pinSecret}.path else null;
      description = "The PIV PIN, readable by the talos-attest group, for ATTEST_CA_PKCS11_PIN_FILE.";
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
                (subject.user == "root" || subject.isInGroup("talos-attest"))) {
              return polkit.Result.YES;
            }
          });
        '';
        services.udev.packages = [ pkgs.yubikey-personalization ];
        # pcscd runs as its own user; the Yubico rules admit only logged-in users.
        services.udev.extraRules = ''
          SUBSYSTEM=="usb", ATTR{idVendor}=="1050", GROUP="pcscd", MODE="0660"
        '';

        users.groups.talos-attest = { };

        environment.systemPackages = [
          pkgs.opensc
          pkgs.openssl
          pkgs.yubico-piv-tool
          pkgs.yubikey-manager
        ];
        # A stable path for pkcs11-tool in the setup script, independent of the store path.
        environment.etc."devid-ca/libykcs11.so".source = cfg.pkcs11Module;
      }
      (lib.mkIf provisioned {
        sops.secrets.${pinSecret} = {
          group = "talos-attest";
          mode = "0440";
        };
      })
    ]
  );
}
