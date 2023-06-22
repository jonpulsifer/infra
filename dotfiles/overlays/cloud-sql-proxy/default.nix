final: prev: {
  cloud-sql-proxy = prev.cloud-sql-proxy.overrideAttrs (old: rec {
    version = "2.3.0";

    src = prev.fetchFromGitHub {
      owner = "GoogleCloudPlatform";
      repo = "cloud-sql-proxy";
      rev = "v${version}";
      hash = "sha256-NT3PXUvOkcKS4FgKVb7kdI7Ic7w9D3rZiEM7dkQCojw=";
    };
    vendorSha256 = "";
  });
}
