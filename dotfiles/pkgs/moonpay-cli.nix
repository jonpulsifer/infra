{
  lib,
  buildNpmPackage,
  fetchurl,
}:

buildNpmPackage (finalAttrs: {
  pname = "moonpay-cli";
  # renovate: datasource=npm depName=@moonpay/cli
  version = "0.8.2";

  src = fetchurl {
    url = "https://registry.npmjs.org/@moonpay/cli/-/cli-${finalAttrs.version}.tgz";
    hash = "sha256-BzX76UhfBtZ67lPJPNXgxiAGH3DgNJELyuWYWy1jpDg=";
  };

  sourceRoot = "package";

  postPatch = ''
    cp ${./moonpay-cli-package-lock.json} package-lock.json
  '';

  npmDepsHash = "sha256-O50WQ2nyoIWVReA2ZEcBWi88ofaMglYFf4RXycEgMj0=";

  dontNpmBuild = true;

  meta = {
    description = "MoonPay CLI — the crypto onramp for AI agents";
    homepage = "https://agents.moonpay.com";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
    mainProgram = "mp";
  };
})
