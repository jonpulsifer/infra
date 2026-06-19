{ lib, buildGoModule }:
buildGoModule {
  pname = "ddnsd";
  version = "0.0.1";
  src = ./.;
  vendorHash = "sha256-OtkEH9Zm9puEss8xA3zd05oogxnwSAL0tXRaw+c2ZjU=";
  subPackages = [ "." ];

  meta = with lib; {
    description = "A dynamic DNS updater for Cloudflare-managed domains";
    homepage = "https://github.com/jonpulsifer/infra/tree/main/apps/ddnsd";
    license = licenses.mit;
    maintainers = [ ];
    platforms = platforms.linux;
  };
}
