{ stdenv, fetchurl, installShellFiles, lib }:
let
  version = "1.31.2";
  sources = {
    aarch64-linux = [
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/linux/arm64/kubectl";
        hash = "";
      })
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/linux/arm64/kubeadm";
        hash = "";
      })
    ];
    x86_64-linux = [
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/linux/amd64/kubectl";
        hash = "sha256-DGgMkIksQ+XOcI6RiCH5JEXR0kT5s9dRMCO8rppiRtE=";
      })
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/linux/amd64/kubeadm";
        hash = "sha256-zjhIsd+lYuD6L5EaPY47sHugQO6nZlTWjiEzFciEasA=";
      })
    ];
    aarch64-darwin = [
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/darwin/arm64/kubectl";
        hash = "sha256-B5LVcNIPxJXqZLrsJs1r3pYUNLkAA48pUvMzRQGHLoA=";
      })
    ];
    x86_64-darwin = [
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/darwin/amd64/kubectl";
        hash = "";
      })
    ];
  };
in
stdenv.mkDerivation rec {
  inherit version;
  pname = "kubectl";
  srcs = sources.${stdenv.hostPlatform.system};

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
  meta = with lib; {
    description = "The Kubernetes command-line tool";
    homepage = "https://kubernetes.io/docs/reference/kubectl/";
    license = licenses.asl20;
    mainProgram = "kubectl";
  };

  platforms = [
    "x86_64-linux"
    "aarch64-darwin"
  ];
}
