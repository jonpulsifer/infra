{ lib, buildGoModule, go_1_27 }:
(buildGoModule.override { go = go_1_27; }) {
  pname = "ddnsd";
  version = "0.0.1";
  src = ./.;
  vendorHash = "sha256-Q49uB2DxjqBfOa279WVBRKUCE2hW7u+/jVAAzcV7/dw=";
  subPackages = [ "." ];

  meta = with lib; {
    description = "A dynamic DNS updater for Cloudflare-managed domains";
    homepage = "https://github.com/jonpulsifer/infra/tree/main/apps/ddnsd";
    license = licenses.mit;
    maintainers = [ ];
    platforms = platforms.linux;
  };
}
