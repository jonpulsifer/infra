{ lib, stdenv, fetchurl, undmg }:
stdenv.mkDerivation rec {
  pname = "sonos";
  version = "15.2";
  name = "${pname}-${version}";
  src = fetchurl {
    name = "sonos-s2-${version}.dmg";
    url = "https://www.sonos.com/redir/controller_software_mac2";
    sha256 = "sha256-zW7Bk0M3GQfiaDrqRbhPnms+S619gB9bTrL4Zj+fuww=";
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
