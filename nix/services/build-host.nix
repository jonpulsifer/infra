# Native arm64 build, OCI image build, and binary-cache role. Forge imports
# this module and is the build target for the Pi fleet, including the aarch64
# build platform used by the armv6l cross configurations.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.services.buildHost;
in
{
  options.services.buildHost = {
    enable = mkEnableOption "arm64 Nix + OCI build host role";
    maxJobs = mkOption {
      type = types.ints.unsigned;
      default = 4;
      description = "nix.settings.max-jobs. The Pi 5 has 4 cores; raise for x86 hosts.";
    };
    serveRemoteBuilders = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Run nix-daemon as a remote-builder listener (nix.distributedBuilds).
        Other aarch64 hosts in the lab opt in by adding a `nix.buildMachines`
        entry pointing at this host -- this option only flips the listener.
      '';
    };
    ociBuilder = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Install docker + buildx for native arm64 OCI image builds. Replaces
        x86 cross-builds from the GitHub Actions `nix-image-builder` workflow
        for the arm64 targets that need native builds (e.g. anything with
        cgo, kernel modules, or arch-specific assembly).
      '';
    };
    binaryCache = mkOption {
      type = types.nullOr (types.enum [ "harmonia" ]);
      default = null;
      description = ''
        Run a local arm64 binary cache. Harmonia signs with a key whose
        path is given by `binaryCacheSigningKeyPath`. The host config is
        expected to materialize that path (typically via sops-nix).
      '';
    };
    binaryCacheSigningKeyPath = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        Filesystem path to the binary-cache signing private key. Required
        when `binaryCache = "harmonia"`. The host config typically wires
        this to a sops-decrypted file (e.g.
        `config.sops.secrets."harmonia-cache-key".path`).
      '';
    };
  };

  config = mkIf cfg.enable {
    nix = {
      settings.max-jobs = cfg.maxJobs;
      distributedBuilds = cfg.serveRemoteBuilders;
    };

    # The remote-builder listener is just sshd + the standard nix-daemon
    # `nix` user; the daemon accepts a build from anyone presenting a key
    # the operator trusts. Tailnet + lab-vlan firewall is the network-side
    # gate; this host's firewall stays on (common.nix default).
    services.openssh.openFirewall = mkIf cfg.serveRemoteBuilders true;

    virtualisation.docker.enable = cfg.ociBuilder;
    environment.systemPackages = mkIf cfg.ociBuilder [
      pkgs.docker-buildx
    ];

    # Harmonia: the sops file (`sops.secrets."harmonia-cache-key"`) gives a
    # 0444-mode file with the binary-cache signing private key. The public
    # half lives in the clear at nix/secrets/<host>-harmonia-cache.pub and
    # is what clients pin in their `trusted-public-keys`.
    #
    # Bound to 127.0.0.1:5000; the host's nginx fronts it on the lab VLAN
    # + tailnet. The nginx vhost lives in the host config (not here) so
    # this module stays host-agnostic.
    services.harmonia.cache = mkIf (cfg.binaryCache == "harmonia") {
      enable = true;
      signKeyPaths = [ cfg.binaryCacheSigningKeyPath ];
      settings = {
        bind = "127.0.0.1:5000";
        priority = 40;
      };
    };
  };
}
