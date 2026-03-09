{
  lib,
  buildNpmPackage,
  fetchurl,
}:

buildNpmPackage (finalAttrs: {
  pname = "moonpay-cli";
  # renovate: datasource=npm depName=@moonpay/cli
  version = "0.13.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/@moonpay/cli/-/cli-${finalAttrs.version}.tgz";
    hash = "sha256-xhClkwRKXfdd9NzRsHsTmF4gXs9oxdbAT0XdkDqKB30=";
  };

  sourceRoot = "package";

  postPatch = ''
    cp ${./moonpay-cli-package-lock.json} package-lock.json
  '';

  npmDepsHash = "sha256-E1wYxH00/PWx9fvmgd95hdyG5EnVTkv4qDP9MG0dqcQ=";

  npmFlags = [ "--include=optional" ];
  dontNpmBuild = true;

  meta = {
    description = "MoonPay CLI — the crypto onramp for AI agents";
    homepage = "https://agents.moonpay.com";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
    mainProgram = "mp";
  };
})
