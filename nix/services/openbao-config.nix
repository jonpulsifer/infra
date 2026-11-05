# The PKI inside OpenBao, as code: a oneshot that puts the mounts, roles and policies that git
# declares into the server after it unseals, and again each day, the way spire-server-entries
# keeps the SPIRE entries. The issuing CA's key is born in the server; its CSR waits in
# /var/lib/openbao-config for the root ceremony, and the signed certificate comes back through
# git. docs/runbooks/sign-the-issuing-ca.md has the steps.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.openbao;
  pki = cfg.pki;
  issuingCertPath = ../../terraform/pki/certs/folly-issuing-ca.pem;
  tokenSecret = "openbao/config-token";
  service = "openbao-config";
in
{
  options.homelab.openbao.pki = {
    enable = lib.mkEnableOption "the PKI that git declares inside this OpenBao server";

    mount = lib.mkOption {
      type = lib.types.str;
      default = "pki/folly";
      description = "The PKI mount of the issuing CA.";
    };

    issuingCommonName = lib.mkOption {
      type = lib.types.str;
      default = "FML folly Issuing CA";
      description = "The CN of the issuing CA, under the FML root.";
    };

    issuingCert = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = if builtins.pathExists issuingCertPath then issuingCertPath else null;
      defaultText = "terraform/pki/certs/folly-issuing-ca.pem when it exists";
      description = "The issuing CA's certificate, signed by the root. Null while the ceremony has not signed it.";
    };

    maxLeaseTTL = lib.mkOption {
      type = lib.types.str;
      default = "43830h";
      description = "The mount's longest certificate: five years, the DevID CA's term. Each role caps its own.";
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
        MOUNT = pki.mount;
        STATE_DIR = "/var/lib/${service}";
        ISSUING_CN = pki.issuingCommonName;
        ORG = "Folly Mountain Laboratories";
        MAX_TTL = pki.maxLeaseTTL;
        # Interpolation copies each file into the store; toString would name the checkout.
        ISSUING_CERT = if pki.issuingCert == null then "" else "${pki.issuingCert}";
        ROOT_CERT = "${../../terraform/pki/certs/fml-root.pem}";
        POLICY_DIR = "${./openbao/policies}";
        CONFIG_POLICY = "${./openbao/config-policy.hcl}";
      };
      serviceConfig = {
        # Not RemainAfterExit, so the timer's start runs it again.
        Type = "oneshot";
        DynamicUser = true;
        # The CSR is read by the owner over ssh, so the directory is open to read.
        StateDirectory = service;
        StateDirectoryMode = "0755";
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
