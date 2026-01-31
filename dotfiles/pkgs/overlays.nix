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
      version = "0.25.2";
      src = prev.fetchurl {
        url = "https://github.com/google-gemini/gemini-cli/releases/download/v${version}/gemini.js";
        hash = "sha256-k5zGtNlpW+T41DxrKexaqLinV5CzrQYepW+MKVYoS9o=";
      };
    });
  })
]
