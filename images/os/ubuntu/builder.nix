{
  lib,
  writeShellApplication,
  fetchurl,
  runCommand,
  buildEnv,
  mkosi-full,
  systemd,
  systemdUkify,
  util-linux,
  dpkg,
  apt,
  gnupg,
  e2fsprogs,
  dosfstools,
  mtools,
  erofs-utils,
  squashfsTools,
  cryptsetup,
  binutils,
  findutils,
  gnutar,
  gzip,
  xz,
  zstd,
  curl,
  bash,
  coreutils,
  gnugrep,
  gnused,
  gawk,
  git,
}:
let
  keyringDeb = fetchurl {
    url = "https://snapshot.ubuntu.com/ubuntu/20261110T000000Z/pool/main/u/ubuntu-keyring/ubuntu-keyring_2026.08.18_all.deb";
    hash = "sha256-/sEL2B2c6AmlwRxiJ6NnYR3Q4lia/rtB1Grvs1C+j0A=";
  };

  keyring = runCommand "ubuntu-archive-keyring" { nativeBuildInputs = [ dpkg ]; } ''
    dpkg-deb -x ${keyringDeb} x
    install -Dm644 x/usr/share/keyrings/ubuntu-archive-keyring.gpg \
      $out/share/keyrings/ubuntu-archive-keyring.gpg
  '';

  tools = [
    mkosi-full
    systemdUkify
    systemd
    util-linux
    dpkg
    apt
    gnupg
    e2fsprogs
    dosfstools
    mtools
    erofs-utils
    squashfsTools
    cryptsetup
    binutils
    findutils
    gnutar
    gzip
    xz
    zstd
    curl
    bash
    coreutils
    gnugrep
    gnused
    gawk
    git
  ];

  usr = buildEnv {
    name = "ubuntu-builder-usr";
    paths = [
      keyring
      dpkg
      apt
      gnupg
      e2fsprogs
      dosfstools
      mtools
    ];
    pathsToLink = [
      "/bin"
      "/share/keyrings"
    ];
  };
in
writeShellApplication {
  name = "image-ubuntu";
  runtimeInputs = tools;
  text = ''
    root=$(git rev-parse --show-toplevel)
    cache=''${XDG_CACHE_HOME:-$HOME/.cache}/image-ubuntu
    mkdir -p "$cache/pkgs" "$cache/ws"
    export PATH="$PATH:/run/wrappers/bin"
    export XDG_CACHE_HOME=$cache

    exec unshare --mount --map-auto --map-root-user sh -c '
      mount --bind ${usr} /usr
      exec "$@"
    ' sh mkosi \
      --directory "$root/images/os/ubuntu" \
      --package-cache-dir "$cache/pkgs" \
      --workspace-dir "$cache/ws" \
      "$@"
  '';
}
