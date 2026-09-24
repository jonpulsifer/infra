# OCI image for the PBX pod: Asterisk, plus the tools its config-render init
# container and provisioning sidecar run. nixpkgs' stock Asterisk already has
# res_pjsip, res_prometheus, res_srtp and the ulaw/g722 codecs the trunks need.
{
  asterisk,
  bash,
  cacert,
  coreutils,
  darkhttpd,
  dockerTools,
  gettext,
}:
let
  runtime = [
    asterisk
    bash
    coreutils
    # envsubst: Asterisk config does not interpolate, so the init container
    # renders the trunk passwords from the environment into it.
    gettext
    # The handset provisioning server the sidecar runs.
    darkhttpd
    cacert
  ];

  # Hashing the runtime store paths gives any change a new tag. Pods pull with
  # IfNotPresent, so a reused tag runs whatever copy a node already has.
  contentTag = builtins.substring 0 8 (
    builtins.hashString "sha256" (builtins.concatStringsSep ":" (map toString runtime))
  );
in
dockerTools.streamLayeredImage {
  name = "ghcr.io/jonpulsifer/asterisk";
  tag = "${asterisk.version}-${contentTag}";

  # Links the store's /var/lib/asterisk into place. Asterisk aborts with
  # "Stasis initialization failed" if documentation/core-en_US.xml is missing.
  contents = runtime;

  # The writable paths Asterisk opens on boot, so a plain `docker run` works.
  # asterisk.conf sets astdbdir to asterisk-db; /var/lib/asterisk is read-only.
  extraCommands = ''
    mkdir -p etc/asterisk var/lib/asterisk-db var/log/asterisk var/spool/asterisk var/run/asterisk var/cache/asterisk tmp
    chmod 1777 tmp
  '';

  config = {
    Entrypoint = [ "${asterisk}/bin/asterisk" ];
    # No -U: the pod's securityContext sets the user.
    Cmd = [
      "-f"
      "-C"
      "/etc/asterisk/asterisk.conf"
    ];
    ExposedPorts = {
      "5060/udp" = { };
      "5060/tcp" = { };
      "8088/tcp" = { };
    };
    Env = [ "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt" ];
  };
}
