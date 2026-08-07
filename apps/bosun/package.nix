{ lib, buildGoModule }:
buildGoModule {
  pname = "bosun";
  version = "0.0.1";
  src = ./.;
  vendorHash = null;
  subPackages = [ "." ];

  meta = with lib; {
    description = "Keeps a warm pool of ephemeral microVM GitHub Actions runners";
    homepage = "https://github.com/jonpulsifer/infra/tree/main/apps/bosun";
    license = licenses.mit;
    maintainers = [ ];
    platforms = platforms.linux;
  };
}
