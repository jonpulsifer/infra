# Overlays for pkgs.unstable
{ opencode }:
[
  # Always use latest opencode from upstream flake
  (final: prev: {
    opencode = opencode.packages.${prev.system}.default;
  })
  # gemini-cli from nixpkgs-unstable (updates naturally with flake.lock)
]
