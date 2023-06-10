{ lib, stdenv, fetchurl, undmg }:
stdenv.mkDerivation rec {
  pname = "sonos";
  version = "73.0-41050";
  name = "${pname}-${version}";
  src = fetchurl {
    name = "Sonos_${version}.dmg";
    url = "https://www.sonos.com/redir/controller_software_mac2";
    sha256 = "sha256-OSW08RbpAxh1LhIKuHORM/6NrKXJIJSoFFmC8Q/GlqE=";
    # curlOpts = " - O - J - L ";
  };
  nativeBuildInputs = [ undmg ];
  sourceRoot = ".";
  installPhase = ''
    mkdir -p $out/Applications
    cp -vr *.app $out/Applications
  '';
  meta = with lib; {
    description = "The Sonos S2 app lets you control Sonos systems with products that are compatible with S2.";
    homepage = "https://support.sonos.com/en-ca/article/release-notes-for-sonos-s2";
    license = {
      fullName = "Sonos Terms of Use, License and Warranty Agreement";
      url = "https://www.sonos.com/legal/terms";
      free = false;
    };
    maintainers = with maintainers; [ jonpulsifer ];
    platforms = [ "aarch64-darwin" "x86_64-darwin" ];
  };
}
