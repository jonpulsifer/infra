{ stdenv, fetchurl, installShellFiles }:
let
  version = "1.26.1";
  sources = {
    aarch64-linux = [
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/linux/arm64/kubectl";
        hash = "sha256-ebFOTdranoHSmJ82qJ+qnlb4q+bgJG573DBck8NzHqQ=";
      })
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/linux/arm64/kubeadm";
        hash = "sha256-ZShEyVGHhic+CUglt0oZiMhxVS3GzPcTZlWOZ0CYWdE=";
      })
    ];
    x86_64-linux = [
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/linux/amd64/kubectl";
        hash = "sha256-1XviLPol90J8+1OM/IhT12OHj4s2x2zpODD28tZ8bl0=";
      })
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/linux/amd64/kubeadm";
        hash = "sha256-FTGr/pbi6divkhkZLGXQTfhQekagga4eEBR46V0rY9o=";
      })
    ];
    aarch64-darwin = [
      (fetchurl {
        url = "https://dl.k8s.io/release/v${version}/bin/darwin/arm64/kubectl";
        hash = "sha256-XoS2eKVPWO464X+jxlvGDVXwwLYWzy3CGoxWdyx48eU=";
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

  platforms = [
    "x86_64-linux"
    "aarch64-darwin"
  ];
}
