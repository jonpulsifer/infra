{
  lib,
  buildGoModule,
  go_1_27,
}:
(buildGoModule.override { go = go_1_27; }) {
  pname = "talos-attest";
  version = "0.0.1";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./go.mod
      ./go.sum
      ./policy.yaml
      ./roots
      ./testdata
      (lib.fileset.fileFilter (file: file.hasExt "go") ./.)
    ];
  };
  vendorHash = "sha256-yo0kPB4XOSpMIjMIwhOhRSjDgYxiqx7fvkAS9tZuC08=";
  subPackages = [
    "."
    "cmd/tink-attest"
  ];
  # The software-TPM tests need cgo; the go workflow runs them.
  env.CGO_ENABLED = "0";

  meta = {
    description = "Attests a Talos node's TPM and boot chain, and issues its LDevID and LAK certificates";
    homepage = "https://github.com/jonpulsifer/infra/tree/main/apps/talos-attest";
    license = lib.licenses.mit;
    mainProgram = "talos-attest";
    platforms = lib.platforms.linux;
  };
}
