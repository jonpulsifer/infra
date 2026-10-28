{
  lib,
  buildGoModule,
  go_1_27,
}:
(buildGoModule.override { go = go_1_27; }) {
  pname = "talos-attest";
  version = "0.0.1";
  # go.mod replaces pkcs11signer with ../../packages/pkcs11signer, so the source is rooted at the repo.
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ./go.mod
      ./go.sum
      ./policy.yaml
      ./roots
      ./testdata
      (lib.fileset.fileFilter (file: file.hasExt "go") ./.)
      ../../packages/pkcs11signer/go.mod
      ../../packages/pkcs11signer/go.sum
      (lib.fileset.fileFilter (file: file.hasExt "go") ../../packages/pkcs11signer)
    ];
  };
  modRoot = "apps/talos-attest";
  vendorHash = "sha256-LAs8Oar6mB2yNQPzHtcASKkdVqDPB6kfOT8FanVf8bg=";
  subPackages = [
    "."
    "cmd/tink-attest"
  ];
  # cgo loads a PKCS#11 module such as ykcs11 for a DevID CA key on a token.
  env.CGO_ENABLED = "1";
  # The software-TPM tests need the simulator's C sources, which vendoring drops; the go workflow
  # runs them with cgo, and this check runs the rest without.
  preCheck = "export CGO_ENABLED=0";

  meta = {
    description = "Attests a Talos node's TPM and boot chain, and issues its LDevID and LAK certificates";
    homepage = "https://github.com/jonpulsifer/infra/tree/main/apps/talos-attest";
    license = lib.licenses.mit;
    mainProgram = "talos-attest";
    platforms = lib.platforms.linux;
  };
}
