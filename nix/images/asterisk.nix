# A lean OCI image carrying Asterisk and the two tools its entrypoint needs.
#
# Nix rather than a Dockerfile because there is no good base to build one on:
# Debian stable dropped the `asterisk` package entirely — trixie ships the
# sound files and nothing else — so an `apt install` image would have to track
# sid, and every community image on GHCR is one volunteer's side project.
# nixpkgs pins 22.8.2 (the 22 LTS), builds from source, and is already in
# cache.nixos.org, so this costs a download rather than a compile.
#
# That build carries every module the two sites need without a menuselect
# patch: res_pjsip with its outbound registration and digest-auth companions
# for the voip.ms and ElevenLabs trunks, res_prometheus for /metrics, res_srtp
# for encrypted media, and the ulaw/g722 codecs ElevenLabs requires.
{
  asterisk,
  bash,
  cacert,
  coreutils,
  dockerTools,
  gettext,
}:
dockerTools.streamLayeredImage {
  name = "ghcr.io/jonpulsifer/asterisk";
  tag = asterisk.version;

  contents = [
    asterisk
    bash
    coreutils
    # envsubst. The entrypoint renders pjsip.conf from a template because trunk
    # passwords arrive as environment variables from an ExternalSecret, and
    # Asterisk config files do not interpolate.
    gettext
    cacert
  ];

  # Asterisk opens these on boot. Kubernetes mounts an emptyDir over each
  # writable one and the config over /etc/asterisk; they exist here so the
  # image also runs under a plain `docker run`.
  #
  # Only the writable ones are created here. nixpkgs compiles the read-only
  # directories to their FHS paths rather than store paths, and the buildEnv
  # union above satisfies them: /var/lib/asterisk ends up holding the sounds,
  # the firmware and documentation/core-en_US.xml as links into the store. That
  # last file is load-bearing — Asterisk aborts with "Stasis initialization
  # failed" if it cannot read it, long before it reaches a dialplan.
  #
  # asterisk-db is the exception and the reason asterisk.conf redirects
  # astdbdir: astdb.sqlite3 is opened read-write, and its default is inside the
  # read-only /var/lib/asterisk above.
  extraCommands = ''
    mkdir -p etc/asterisk var/lib/asterisk-db var/log/asterisk var/spool/asterisk var/run/asterisk var/cache/asterisk tmp
    chmod 1777 tmp
  '';

  config = {
    Entrypoint = [ "${asterisk}/bin/asterisk" ];
    # Foreground, no console, no privilege drop — the pod's securityContext
    # already decides who this runs as.
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
