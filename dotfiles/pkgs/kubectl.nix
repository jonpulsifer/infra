{
  stdenv,
  fetchurl,
  installShellFiles,
  lib,
}:
let
  version = "1.31.2";
in
stdenv.mkDerivation rec {
  inherit version;
  pname = "kubectl";
  srcs = {
    x86_64-linux = [
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/linux/amd64/kubectl";
        hash = "sha256-OZ6dGZXagLZNLvNgbBojkBhmDYs1IJ+6P3sLwRxjHGg=";
      })
    ];
    aarch64-darwin = [
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/darwin/arm64/kubectl";
        hash = "sha256-B5LVcNIPxJXqZLrsJs1r3pYUNLkAA48pUvMzRQGHLoA=";
      })
    ];
  };

  dontUnpack = true;

  nativeBuildInputs = [ installShellFiles ];

  installPhase = ''
    for src in $srcs; do
      local name=$(stripHash $src)
      install -m755 -D $src $out/bin/$name
      installShellCompletion --cmd $name \
      --zsh <($out/bin/kubectl completion zsh)
    done
  '';
  meta = {
    description = "Kubernetes CLI";
    homepage = "https://github.com/kubernetes/kubectl";
    mainProgram = "kubectl";
    platforms = lib.platforms.unix;
  };

  platforms = [
    "x86_64-linux"
    "aarch64-darwin"
  ];
}
