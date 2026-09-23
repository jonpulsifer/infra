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
  darkhttpd,
  dockerTools,
  gettext,
}:
let
  runtime = [
    asterisk
    bash
    coreutils
    # envsubst. The entrypoint renders pjsip.conf from a template because trunk
    # passwords arrive as environment variables from an ExternalSecret, and
    # Asterisk config files do not interpolate.
    gettext
    # The provisioning server folly runs beside Asterisk. In the same image
    # because it is one static directory served read-only on a LAN — a second
    # image, and a second thing in CI, for 100KB of C.
    darkhttpd
    cacert
  ];

  # The tag carries a hash of what is in the image, not just the Asterisk
  # version, and that is load-bearing rather than decorative.
  #
  # A tag of `asterisk.version` alone does not move when the *contents* change
  # — adding darkhttpd left it at 22.8.2 — so the registry gets a new image
  # under an old name. Kubernetes defaults a non-`latest` tag to
  # imagePullPolicy IfNotPresent, the node keeps the copy it already has, and
  # the pod runs an image that no longer matches the manifest that asked for
  # it. That is how the provisioning sidecar ended up executing a binary its
  # own Dockerfile-equivalent contained: `exec: "/bin/darkhttpd": no such file
  # or directory`, against an image where it very much existed.
  #
  # Hashing the store paths means any component changing produces a new tag,
  # the manifest has to name it, and the CI guard beside this fails the pull
  # request until it does. Tags stop being mutable, so IfNotPresent becomes
  # correct rather than dangerous.
  contentTag = builtins.substring 0 8 (
    builtins.hashString "sha256" (builtins.concatStringsSep ":" (map toString runtime))
  );
in
dockerTools.streamLayeredImage {
  name = "ghcr.io/jonpulsifer/asterisk";
  tag = "${asterisk.version}-${contentTag}";

  contents = runtime;

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
