{ buildGoModule, fetchFromGitHub, lib }:

buildGoModule rec {
  pname = "ddnsb0t";
  version = "0.0.3";

  src = fetchFromGitHub {
    owner = "jonpulsifer";
    repo = "ddnsb0t";
    rev = "6c98188d304c12e1048e5c02a4c119af8f4cde88";
    sha256 = "sha256-tuBXEjn0BDvf6X9xH/RBnyxI0/2z7pxtLW4R6ViYnDc=";
  };
  vendorSha256 = "sha256-JGoimKimsx92WybQ9xHQ0q+18P93uafE35szZgWQOqM=";
  subPackages = [ "." ];

  meta = with lib; {
    description =
      "ddnsb0t is a program that uses CloudEvents to communicate to a Google Cloud Function and update my DNS entries using Google Cloud DNS.";
    homepage = "https://github.com/jonpulsifer/ddnsb0t";
    license = licenses.mit;
    maintainers = with maintainers; [ jonpulsifer ];
    platforms = platforms.aarch64 ++ platforms.linux ++ platforms.darwin;
  };
}
