{
  lib,
  buildNpmPackage,
  fetchurl,
}:

buildNpmPackage (finalAttrs: {
  pname = "moonpay-cli";
  # renovate: datasource=npm depName=@moonpay/cli
  version = "0.12.13";

  src = fetchurl {
    url = "https://registry.npmjs.org/@moonpay/cli/-/cli-${finalAttrs.version}.tgz";
    hash = "sha256-geUXBZBkfsJMXaPyMS57HTLxlnkctTi/G7yUZXSkbhA=";
  };

  sourceRoot = "package";

  postPatch = ''
    cp ${./moonpay-cli-package-lock.json} package-lock.json
  '';

  npmDepsHash = "sha256-lsCr/7V9hq+jTr4z4rRSuKBmMGxe/0r21Ybe24JC0QA=";

  npmFlags = [ "--include=optional" ];
  dontNpmBuild = true;

  meta = {
    description = "MoonPay CLI — the crypto onramp for AI agents";
    homepage = "https://agents.moonpay.com";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
    mainProgram = "mp";
  };
})
