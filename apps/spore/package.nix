{
  autoPatchelfHook,
  buildNpmPackage,
  esbuild,
  lib,
  makeWrapper,
  nodejs_24,
  python3,
  removeReferencesTo,
  sqlite,
  srcOnly,
  stdenv,
}:
let
  nodeSources = srcOnly nodejs_24;
in
buildNpmPackage {
  pname = "spore";
  version = "0.1.0";
  nodejs = nodejs_24;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./app
      ./components
      ./lib
      ./migrations
      ./scripts
      ./next.config.ts
      ./package-lock.json
      ./package.json
      ./postcss.config.mjs
      ./tsconfig.json
    ];
  };
  npmDepsHash = "sha256-QEmYVYUE5NDMHVNIuQCaiByO8uvInMgNXUqs144sMeE=";

  nativeBuildInputs = [
    autoPatchelfHook
    esbuild
    makeWrapper
    python3
    removeReferencesTo
  ];
  buildInputs = [ stdenv.cc.cc.lib ];

  env = {
    NEXT_TELEMETRY_DISABLED = "1";
  };

  postBuild = ''
    # The npm config hook's offline rebuild compiles better-sqlite3 against the
    # target Node release. Remove its build-time Node source references before
    # copying the standalone application into the output closure.
    find node_modules/better-sqlite3/build -type f \
      -exec ${lib.getExe removeReferencesTo} -t "${nodeSources}" {} \;

    esbuild scripts/migrate.ts \
      --bundle \
      --platform=node \
      --target=node24 \
      --format=esm \
      --external:better-sqlite3 \
      --outfile=migrate.mjs
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/spore/.next" "$out/bin"
    cp -r .next/standalone/. "$out/share/spore/"
    cp -r .next/static "$out/share/spore/.next/static"
    if [ -d public ]; then
      cp -r public "$out/share/spore/public"
    fi
    cp migrate.mjs "$out/share/spore/migrate.mjs"
    cp -r migrations "$out/share/spore/migrations"

    makeWrapper ${lib.getExe nodejs_24} "$out/bin/spore" \
      --add-flags "$out/share/spore/server.js" \
      --set-default NEXT_TELEMETRY_DISABLED 1
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/spore-migrate" \
      --add-flags "$out/share/spore/migrate.mjs" \
      --set-default SPORE_MIGRATIONS_DIR "$out/share/spore/migrations"

    # Fail immediately if Next's trace omitted the native addon, it was built
    # for a different Node ABI, or the packaged migration cannot execute SQL.
    smoke_dir=$(mktemp -d)
    DATABASE_URL="file:$smoke_dir/observations.db" \
      "$out/bin/spore-migrate"
    ${lib.getExe sqlite} "$smoke_dir/observations.db" \
      'SELECT 1 FROM host_observations LIMIT 0;'

    runHook postInstall
  '';

  meta = {
    description = "Read-only network-boot catalog and observation UI";
    license = lib.licenses.mit;
    mainProgram = "spore";
    platforms = lib.platforms.linux;
  };
}
