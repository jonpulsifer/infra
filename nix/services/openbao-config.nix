# The PKI inside OpenBao, as code: a oneshot that puts the mounts, roles and policies that git
# declares into the server after it unseals, and again each day, the way spire-server-entries
# keeps the SPIRE entries. The root and the issuing CA are born in the server and never leave it.
# docs/runbooks/configure-openbao-pki.md has the steps.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.openbao;
  pki = cfg.pki;
  tokenSecret = "openbao/config-token";
  service = "openbao-config";
in
{
  options.homelab.openbao.pki = {
    enable = lib.mkEnableOption "the PKI that git declares inside this OpenBao server";

    rootMount = lib.mkOption {
      type = lib.types.str;
      default = "pki/root";
      description = "The PKI mount of the FML root, which signs the issuing CA and nothing else.";
    };

    rootCommonName = lib.mkOption {
      type = lib.types.str;
      default = "FML Root CA";
      description = "The CN of the root.";
    };

    rootTTL = lib.mkOption {
      type = lib.types.str;
      default = "175320h";
      description = "The root's term, and its mount's longest certificate: twenty years.";
    };

    mount = lib.mkOption {
      type = lib.types.str;
      default = "pki/folly";
      description = "The PKI mount of the issuing CA.";
    };

    issuingCommonName = lib.mkOption {
      type = lib.types.str;
      default = "FML folly Issuing CA";
      description = "The CN of the issuing CA, under the root.";
    };

    issuingTTL = lib.mkOption {
      type = lib.types.str;
      default = "43830h";
      description = "The issuing CA's term, and its mount's longest certificate: five years, the DevID CA's term. Each role caps its own.";
    };

    appRoles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "spire" ];
      description = "The AppRoles, each named for the policy in openbao/policies/ it is bound to, with its name as its role ID. `mise run openbao:approle-secret <role> <host>` stores a secret ID.";
    };
  };

  config = lib.mkIf (cfg.enable && pki.enable) {
    sops.secrets.${tokenSecret} = {
      restartUnits = [ "${service}.service" ];
    };

    systemd.services.${service} = {
      description = "Put the PKI that git declares into OpenBao";
      wantedBy = [ "multi-user.target" ];
      requires = [ "openbao.service" ];
      after = [ "openbao.service" ];
      partOf = [ "openbao.service" ];
      path = [
        config.services.openbao.package
        pkgs.coreutils
        pkgs.gnused
        pkgs.jq
      ];
      environment = {
        BAO_ADDR = config.environment.variables.BAO_ADDR;
        ROOT_MOUNT = pki.rootMount;
        ROOT_CN = pki.rootCommonName;
        ROOT_TTL = pki.rootTTL;
        MOUNT = pki.mount;
        ISSUING_CN = pki.issuingCommonName;
        ISSUING_TTL = pki.issuingTTL;
        ORG = "Folly Mountain Laboratories";
        APPROLES = lib.concatStringsSep " " pki.appRoles;
        # Interpolation copies each directory into the store; toString would name the checkout.
        POLICY_DIR = "${./openbao/policies}";
        CONFIG_POLICY = "${./openbao/config-policy.hcl}";
      };
      serviceConfig = {
        # Not RemainAfterExit, so the timer's start runs it again.
        Type = "oneshot";
        DynamicUser = true;
        LoadCredential = [ "token:${config.sops.secrets.${tokenSecret}.path}" ];
        UMask = "0022";
      };
      script = "exec ${pkgs.runtimeShell} ${./openbao/configure.sh}";
    };

    # The token is periodic; the daily run renews it and reapplies the declaration.
    systemd.timers.${service} = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "daily";
        RandomizedDelaySec = "1h";
        Persistent = true;
      };
    };
  };
}
