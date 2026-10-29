{
  lib,
  buildGoModule,
  go_1_27,
}:
(buildGoModule.override { go = go_1_27; }) {
  pname = "fleet-controller";
  version = "0.0.1";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./go.mod
      ./go.sum
      ./testdata
      (lib.fileset.fileFilter (file: file.hasExt "go") ./.)
    ];
  };
  vendorHash = "sha256-g+yaVIx4jxpAQ/+WrGKxhVeliYx7nLQe/zsGpxV4Fn4=";
  env.CGO_ENABLED = "0";

  meta = {
    description = "Makes Tinkerbell's Hardware, Machine and Workflow objects from NetBox's devices, and renders the Talos config each install fetches";
    homepage = "https://github.com/jonpulsifer/infra/tree/main/apps/fleet-controller";
    license = lib.licenses.mit;
    mainProgram = "fleet-controller";
    platforms = lib.platforms.linux;
  };
}
