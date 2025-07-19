final: prev: {
  runc =
    (prev.runc.override {
      # buildGoModule = prev.buildGo119Module;
      # components = [ "cmd/kubelet" ];
    }).overrideAttrs
      (_: rec {
        version = "1.2.2";
        src = prev.fetchFromGitHub {
          owner = "opencontainers";
          repo = "runc";
          rev = "v${version}";
          hash = "sha256-hRi7TJP73hRd/v8hisEUx9P2I2J5oF0Wv60NWHORI7Y=";
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
