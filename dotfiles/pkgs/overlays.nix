# Overlays for pkgs.unstable
{ opencode }:
[
  # Always use latest opencode from upstream flake
  (final: prev: {
    opencode = opencode.packages.${prev.system}.default;
  })

  # gemini-cli-bin: override to latest release from GitHub
  (final: prev: {
    gemini-cli-bin = prev.gemini-cli-bin.overrideAttrs (oldAttrs: rec {
      # renovate: datasource=github-releases depName=google-gemini/gemini-cli
      version = "0.26.0";
      src = prev.fetchurl {
        url = "https://github.com/google-gemini/gemini-cli/releases/download/v${version}/gemini.js";
        hash = "sha256-IOx+n39JGYmHp42ObLD30H2Lgpju6bDBQ7fHLP1oc60=";
      };

      installPhase = ''
          runHook preInstall

          install -D "$src" "$out/bin/gemini"

          # ideal method to disable auto-update
          sed -i '/disableautoupdate: {/,/}/ s/default: false/default: true/' "$out/bin/gemini"

          # use `ripgrep` from `nixpkgs`, more dependencies but prevent downloading incompatible binary on NixOS
          # this workaround can be removed once the following upstream issue is resolved:
          # https://github.com/google-gemini/gemini-cli/issues/11438
          substituteInPlace $out/bin/gemini \
            --replace-fail 'const existingPath = await resolveExistingRgPath();' 'const existingPath = "${lib.getExe ripgrep}";'

          runHook postInstall
        '';

    });
  })
]
