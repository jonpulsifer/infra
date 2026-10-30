{
  lib,
  buildGoModule,
  go_1_27,
}:
(buildGoModule.override { go = go_1_27; }) {
  pname = "fleetd";
  version = "0.0.1";
  # go.mod replaces pkcs11signer with ../../packages/pkcs11signer, so the source is rooted at the repo.
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ./go.mod
      ./go.sum
      ./attest/policy
      ./attest/roots
      ./attest/testdata
      ./fleet/testdata
      (lib.fileset.fileFilter (file: file.hasExt "go") ./.)
      ../../packages/pkcs11signer/go.mod
      ../../packages/pkcs11signer/go.sum
      (lib.fileset.fileFilter (file: file.hasExt "go") ../../packages/pkcs11signer)
    ];
  };
  modRoot = "apps/fleetd";
  vendorHash = "sha256-LAs8Oar6mB2yNQPzHtcASKkdVqDPB6kfOT8FanVf8bg=";
  subPackages = [
    "."
    "cmd/tink-attest"
  ];
  # cgo loads a PKCS#11 module such as ykcs11 for the DevID CA key on its token.
  env.CGO_ENABLED = "1";
  # The software-TPM tests need the simulator's C sources, which vendoring drops; the go workflow
  # runs them with cgo, and this check runs the rest without.
  preCheck = "export CGO_ENABLED=0";

  meta = {
    description = "Attests folly's machines, issues their LDevIDs, drives their Tinkerbell installs and serves each first boot's Talos config once";
    homepage = "https://github.com/jonpulsifer/infra/tree/main/apps/fleetd";
    license = lib.licenses.mit;
    mainProgram = "fleetd";
    platforms = lib.platforms.linux;
  };
}
