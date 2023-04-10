{ buildGoModule, fetchFromGitHub, lib }:

buildGoModule rec {
  pname = "cloudevents";
  version = "0.4.1";

  src = fetchFromGitHub rec {
    owner = "cloudevents";
    repo = "conformance";
    rev = "v${version}";
    sha256 = "sha256-VqW4DUxXAKN4g2yc768Ig1Q5xn9beKFLK9pmbdrO0cM=";
  };
  vendorSha256 = "sha256-lbEUK4tvN1sqTW6Jl3us74EciX2O8UAqMG/JGOFZOXE=";
  subPackages = [ "cmd/cloudevents" ];
  meta = with lib; {
    description = "cloudevents is a tool for testing CloudEvents receivers.";
    homepage = "https://github.com/cloudevents/conformance";
    license = licenses.asl20;
    maintainers = with maintainers; [ jonpulsifer ];
    platforms = platforms.aarch64 ++ platforms.linux ++ platforms.darwin;
  };
}
