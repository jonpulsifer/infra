final: prev: {
  kubernetes = (prev.kubernetes.override {
    # buildGoModule = prev.buildGo119Module;
    components = [ "cmd/kubelet" ];
  }).overrideAttrs (_: rec {
    # version = "1.26.1";
    # src = prev.fetchFromGitHub {
    #   owner = "kubernetes";
    #   repo = "kubernetes";
    #   rev = "v${version}";
    #   sha256 = "sha256-bC2Q4jWBh27bqLGhvG4JcuHIAQmiGz5jDt9Me9qbVpk=";
    # };
  });
}
