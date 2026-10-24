# SPIRE for spore's server (nix/services/spire-server.nix): SPIRE at the version the cluster agents
# run, and the boxboat TPM node attestor that SPIRE itself does not ship. The plugin is pinned by
# commit and moved to the current plugin SDK; spire-tpm-plugin-sdk.patch carries that go.mod and
# go.sum bump and the two-line ConfigServer change the new SDK needs. To bump either, set the new
# version or commit, replace each hash with lib.fakeHash and copy the hash the build reports. The
# vendor hashes are the same on every platform, so an x86_64 build computes them. SPIRE 1.15.5's
# go.mod requires go 1.26.10, newer than nixos-26.05's 1.26.7, so its compiler comes from unstable.
{
  lib,
  spire,
  buildGoModule,
  fetchFromGitHub,
  go_1_27,
}:
let
  spireWithGo = spire.override { buildGoModule = buildGoModule.override { go = go_1_27; }; };
in
{
  package = spireWithGo.overrideAttrs (
    finalAttrs: _: {
      version = "1.15.5";
      src = fetchFromGitHub {
        owner = "spiffe";
        repo = "spire";
        tag = "v${finalAttrs.version}";
        hash = "sha256-PB9YWdJR7Iy5CXh4fPyp6buUQkijT9SW0Dx5dVGD5z0=";
      };
      vendorHash = "sha256-4DLJ66GyhneMNSLMBb6lUUoYo63zoCDeXWxMv22NRfU=";
      # Upstream's suite takes hours on the aarch64 build; the install check still runs each binary.
      doCheck = false;
    }
  );

  tpmPlugin = buildGoModule {
    pname = "spire-tpm-plugin";
    version = "1.8.7";

    src = fetchFromGitHub {
      owner = "boxboat";
      repo = "spire-tpm-plugin";
      rev = "dc65abf6a51d08c67f0f2b40901344c8a1c7d714";
      hash = "sha256-YFAx+iQGXSUYNEZdbVadTlR/VWXP28+Wk1YJJ2T4lRA=";
    };

    patches = [ ./spire-tpm-plugin-sdk.patch ];

    proxyVendor = true;
    vendorHash = "sha256-6CQ8WXnbYzCQPXXmG6CPsMsMr/uGAJJ/ssV28hsCiag=";

    subPackages = [ "cmd/tpm_attestor_server" ];
    env.CGO_ENABLED = 0;
    ldflags = [
      "-s"
      "-w"
    ];

    meta = {
      description = "TPM 2.0 EK node attestor plugin for the SPIRE server";
      homepage = "https://github.com/boxboat/spire-tpm-plugin";
      license = lib.licenses.asl20;
      mainProgram = "tpm_attestor_server";
    };
  };
}
