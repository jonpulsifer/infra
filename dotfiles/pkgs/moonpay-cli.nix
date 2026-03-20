{
  lib,
  buildNpmPackage,
  fetchurl,
  nodejs,
}:

buildNpmPackage (finalAttrs: {
  pname = "moonpay-cli";
  # renovate: datasource=npm depName=@moonpay/cli
  version = "1.12.3";

  src = fetchurl {
    url = "https://registry.npmjs.org/@moonpay/cli/-/cli-${finalAttrs.version}.tgz";
    hash = "sha256-Q2QYmDyfdg8wbdSOIDetLt6Gbg18D6n9jwdDZ2W7hZs=";
  };

  sourceRoot = "package";

  postPatch = ''
    cp ${./moonpay-cli-package-lock.json} package-lock.json
    # Remove private workspace packages that aren't published to npm
    ${lib.getExe nodejs} -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        if (pkg[section]) {
          for (const [name, ver] of Object.entries(pkg[section])) {
            if (name.startsWith('@moonpay/') && ver === '*') {
              delete pkg[section][name];
            }
          }
        }
      }
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
    "
  '';

  npmDepsHash = "sha256-duSmJ9JotQr49U/Wm4G2JyKDMLjlOJA3+laR1wg9lkQ=";

  npmFlags = [
    "--include=optional"
    "--legacy-peer-deps"
  ];
  dontNpmBuild = true;

  meta = {
    description = "MoonPay CLI — the crypto onramp for AI agents";
    homepage = "https://agents.moonpay.com";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
    mainProgram = "mp";
  };
})
