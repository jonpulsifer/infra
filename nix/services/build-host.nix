# Native arm64 build, OCI image build and binary-cache role. forge imports it and builds for the
# Pi fleet, including the armv6l cross configurations.
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

    # Remote builds arrive over sshd; the tailnet and the lab VLAN firewall are the network gate.
    services.openssh.openFirewall = mkIf cfg.serveRemoteBuilders true;

    virtualisation.docker.enable = cfg.ociBuilder;
    environment.systemPackages = mkIf cfg.ociBuilder [
      pkgs.docker-buildx
    ];

    # Clients pin the public half of the signing key, nix/secrets/<host>-harmonia-cache.pub.
    # An nginx vhost in the host config fronts this localhost listener.
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
