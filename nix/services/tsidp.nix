# tsidp, Tailscale's OIDC provider, as its own tailnet node at https://<hostname>.<tailnet>. People
# on the tailnet sign in at it with kubelogin (scripts/kube-login.sh), and the folly and offsite API
# servers, which have no tailnet, read its discovery document and keys through Funnel. /authorize,
# the admin UI and client registration answer only on the tailnet. The node key, the signing key
# and the registered clients live in /var/lib/tsidp; losing it means a new node and a new client.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.tsidp;
  login = (lib.importJSON ../../clusters/base/config/kube-login.json).providers.tailscale;

  # nixpkgs ships 0.0.12. 0.0.16 reads the auth key from a file, and 0.0.18 needs Go 1.27.3. The
  # vendor hash is upstream's go.mod.sri at the tag.
  tsidp =
    (pkgs.tsidp.override {
      buildGoModule = pkgs.buildGoModule.override { go = pkgs.go_1_27; };
    }).overrideAttrs
      (
        finalAttrs: _: {
          version = "0.0.18";
          src = pkgs.fetchFromGitHub {
            owner = "tailscale";
            repo = "tsidp";
            tag = "v${finalAttrs.version}";
            hash = "sha256-oL+WH5iFVRd0erh3KfJrvUMIpZraomHoRzo5sh3duu0=";
          };
          vendorHash = "sha256-X3o71xgGBFJM3Sspb+223NYsDwJ3jf+9lCWQxS6JDA8=";
          ldflags = [ "-X github.com/tailscale/tsidp/server.version=v${finalAttrs.version}" ];
        }
      );
in
{
  options.homelab.tsidp = {
    enable = lib.mkEnableOption "tsidp, the tailnet's OIDC provider";

    tags = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "tag:tsidp" ];
      description = "Tags the node advertises at its first registration. The OAuth client must be allowed them, and the tailnet policy gives them the funnel node attribute.";
    };
  };

  config = lib.mkIf cfg.enable {
    services.tsidp = {
      enable = true;
      package = tsidp;
      settings = {
        # The Talos roots and kube-login.sh build the issuer URL from the same name.
        hostName = login.hostname;
        enableFunnel = true;
        enableSts = false;
      };
    };

    # The secret of the OAuth client tsidp_enrollment (terraform/network/tailscale/, escrowed in
    # 1Password as "tailscale OAuth (tsidp)") with ?ephemeral=false&preauthorized=true appended, so
    # tsnet mints a non-ephemeral key and the node keeps its identity across restarts. tsidp reads it
    # only while /var/lib/tsidp holds no node key.
    sops.secrets."tsidp/authkey".restartUnits = [ "tsidp.service" ];

    systemd.services.tsidp = {
      environment = {
        TS_AUTHKEY_FILE = "%d/authkey";
        TS_ADVERTISE_TAGS = lib.concatStringsSep "," cfg.tags;
      };
      serviceConfig.LoadCredential = "authkey:${config.sops.secrets."tsidp/authkey".path}";
    };
  };
}
