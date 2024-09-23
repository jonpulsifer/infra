{ stdenv, fetchurl, installShellFiles }:
let
  owner = "tidbyt";
  repo = "pixlet";
  pname = "pixlet";
  version = "0.33.5";
  sources = {
    aarch64-linux = (fetchurl {
      url = "https://github.com/${owner}/${repo}/releases/download/v${version}/${pname}_${version}_linux_arm64.tar.gz";
      hash = "";
    });
    x86_64-linux = (fetchurl {
      url = "https://github.com/${owner}/${repo}/releases/download/v${version}/${pname}_${version}_linux_amd64.tar.gz";
      hash = "";
    });
    aarch64-darwin = (fetchurl {
      url = "https://github.com/${owner}/${repo}/releases/download/v${version}/${pname}_${version}_darwin_arm64.tar.gz";
      hash = "sha256-fhOG+g8myphjwQFEcBjpTwM23uVWRyAQfgqIOnL+LmQ=";
    });
    x86_64-darwin = (fetchurl {
      url = "https://github.com/${owner}/${repo}/releases/download/v${version}/${pname}_${version}_darwin_amd64.tar.gz";
      hash = "";
    });
  };
in
stdenv.mkDerivation rec {
  inherit version pname;
  src = sources.${stdenv.hostPlatform.system};
  nativeBuildInputs = [ installShellFiles ];
  sourceRoot = ".";

  installPhase = ''
    install -D -m755 ${pname} $out/bin/${pname}
    installShellCompletion --cmd ${pname} \
      --zsh <($out/bin/${pname} completion zsh)
  '';

  platforms = [
    "x86_64-linux"
    "aarch64-darwin"
  ];
}
