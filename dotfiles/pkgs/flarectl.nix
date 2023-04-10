{ stdenv, fetchurl, xz }:
let
  version = "0.58.1";
  sources = {
    aarch64-linux = (fetchurl {
      url = "https://github.com/cloudflare/cloudflare-go/releases/download/v${version}/flarectl_${version}_linux_arm64.tar.xz";
      hash = "sha256-rH/PrKVUsVx/e7x9lF8wrWXQuhHDW2nOUF33Gd5922M=";
    });
    x86_64-linux = (fetchurl {
      url = "https://github.com/cloudflare/cloudflare-go/releases/download/v${version}/flarectl_${version}_linux_amd64.tar.xz";
      hash = "sha256-V/hqyFJaxRPun9rZV1u1NhGwy9bdQcRbIPqB/sbHpuo=";
    });
    aarch64-darwin = (fetchurl {
      url = "https://github.com/cloudflare/cloudflare-go/releases/download/v${version}/flarectl_${version}_macos_arm64.tar.xz";
      hash = "sha256-3vMS2LVwTbIbmuqUpThbc5k5H6r9LDMqWZ6a6tSgLEM=";
    });
    x86_64-darwin = (fetchurl {
      url = "https://github.com/cloudflare/cloudflare-go/releases/download/v${version}/flarectl_${version}_macos_amd64.tar.xz";
      hash = "";
    });
  };
in
stdenv.mkDerivation rec {
  inherit version;
  pname = "flarectl";
  src = sources.${stdenv.hostPlatform.system};
  nativeBuildInputs = [ xz ];
  sourceRoot = ".";

  installPhase = ''
    install -D -m755 flarectl $out/bin/flarectl
  '';

  platforms = [
    "x86_64-linux"
    "aarch64-darwin"
  ];
}
