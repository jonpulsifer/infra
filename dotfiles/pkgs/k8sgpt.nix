{ buildGoModule, fetchFromGitHub, lib }:

buildGoModule rec {
  pname = "k8sgpt";
  version = "0.2.0";

  src = fetchFromGitHub rec {
    owner = "k8sgpt-ai";
    repo = "k8sgpt";
    rev = "v${version}";
    sha256 = "sha256-JgYClQM/Sz2Pioug3qNB/zDwnVapqhnTxJZR+HR28R4=";
  };
  vendorSha256 = "sha256-Vwqd+lV7ghMTCFNphflyNfq1414lD4WLxNd5LHVcPbM=";

  meta = with lib; {
    description = "Giving Kubernetes SRE superpowers to everyone";
    homepage = "https://k8sgpt.ai";
    license = licenses.mit;
    maintainers = with maintainers; [ alexsjones ];
    platforms = platforms.aarch64 ++ platforms.linux ++ platforms.darwin;
  };
}
