{
  lib,
  stdenvNoCC,
  fetchFromGitHub,
  bash,
  makeWrapper,
  installShellFiles,
  python3,
  curl,
  coreutils,
  libnotify,
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "peon-ping";
  # renovate: datasource=github-releases depName=PeonPing/peon-ping
  version = "2.12.0";

  src = fetchFromGitHub {
    owner = "PeonPing";
    repo = "peon-ping";
    tag = "v${finalAttrs.version}";
    hash = "sha256-eTXYNMUxEweBtm1NDM4iSWwzqMM2dJfDJSFDp1FoDpM=";
  };

  nativeBuildInputs = [
    makeWrapper
    installShellFiles
  ];

  buildInputs = [ bash ];

  dontBuild = true;

  postPatch = let
    # Escape dollar sign for Nix using string concatenation
    dollar = "$";
  in ''
    # Fix WSL audio path handling - file:// URI needs forward slashes, not backslashes
    # Use wslpath to properly convert WSL paths to Windows paths, then convert backslashes to forward slashes for URI
    # Line 466: replace wpath assignment with wslpath-based conversion
    sed -i '466s|.*|      const wslPath = require("child_process").execSync(`wslpath -w "${dollar}{filePath}"`, { encoding: "utf8", timeout: 5000 }).toString().trim();|' adapters/opencode/peon-ping.ts
    # Insert uriPath line after line 466
    sed -i '466a\      const uriPath = wslPath.replace(/\\\\/g, "/")' adapters/opencode/peon-ping.ts
    # Line 471 (now): replace wpath with uriPath in the URI
    sed -i '471s/wpath/uriPath/' adapters/opencode/peon-ping.ts
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 peon.sh $out/lib/peon-ping/peon.sh
    install -Dm644 config.json $out/lib/peon-ping/config.json

    # Install adapter scripts and helper scripts for IDE integrations
    cp -r adapters $out/lib/peon-ping/adapters
    chmod +x $out/lib/peon-ping/adapters/*.sh
    cp -r scripts $out/lib/peon-ping/scripts
    cp -r skills $out/lib/peon-ping/skills

    makeWrapper $out/lib/peon-ping/peon.sh $out/bin/peon \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            coreutils
            curl
            python3
          ]
          ++ lib.optionals stdenvNoCC.isLinux [ libnotify ]
        )
      }

    installShellCompletion --cmd peon \
      --bash completions.bash \
      --fish completions.fish

    runHook postInstall
  '';

  meta = {
    description = "Notification sound player for AI coding agents";
    longDescription = ''
      peon-ping plays game character voice lines when AI coding agents
      (Claude Code, Cursor, Codex, etc.) need your attention. It supports
      desktop and mobile notifications, multiple sound packs, and integrates
      as hooks in IDE configurations.

      Sound packs must be installed separately into
      ~/.claude/hooks/peon-ping/packs/ — see the project README for details.
    '';
    homepage = "https://github.com/PeonPing/peon-ping";
    changelog = "https://github.com/PeonPing/peon-ping/blob/v${finalAttrs.version}/CHANGELOG.md";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
    mainProgram = "peon";
  };
})
