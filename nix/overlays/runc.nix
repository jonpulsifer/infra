final: prev: {
  runc =
    (prev.runc.override {
      # buildGoModule = prev.buildGo119Module;
      # components = [ "cmd/kubelet" ];
    }).overrideAttrs
      (_: rec {
        version = "1.3.0";
        src = prev.fetchFromGitHub {
          owner = "opencontainers";
          repo = "runc";
          rev = "v${version}";
          hash = "";
        };
        makeFlags = [ "BUILDTAGS+=seccomp" ];

        buildPhase = ''
          runHook preBuild
          patchShebangs .
          make ${toString makeFlags} runc man SHELL=$(command -v bash)
          runHook postBuild
        '';
      });
}
