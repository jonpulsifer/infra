{
  lib,
  buildGoModule,
  go_1_27,
}:
(buildGoModule.override { go = go_1_27; }) {
  pname = "talos-enroll";
  version = "0.0.1";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./go.mod
      ./go.sum
      ./index.html
      (lib.fileset.fileFilter (file: file.hasExt "go") ./.)
    ];
  };
  vendorHash = "sha256-g+yaVIx4jxpAQ/+WrGKxhVeliYx7nLQe/zsGpxV4Fn4=";
  env.CGO_ENABLED = "0";

  meta = {
    description = "The OAuth device flow server that releases a Talos machine's config once the owner approves it";
    homepage = "https://github.com/jonpulsifer/infra/tree/main/apps/talos-enroll";
    license = lib.licenses.mit;
    mainProgram = "talos-enroll";
    platforms = lib.platforms.linux;
  };
}
