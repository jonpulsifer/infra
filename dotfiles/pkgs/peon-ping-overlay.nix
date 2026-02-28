# Wraps the upstream peon-ping flake package with our WSL fix for the OpenCode
# adapter (file:// URI path handling). Packs install and integrations remain
# in home/modules/peon-ping.nix.
#
# The upstream WSL branch does a naive filePath.replace(/\//g, "\\") which
# produces invalid file:// URIs for PowerShell's MediaPlayer. We replace it
# with wslpath -w (proper Windows path) + forward-slash normalisation for the
# URI, while keeping the if (isWSL) { guard intact.
{
  upstreamPeonPing,
  python3,
}:
upstreamPeonPing.overrideAttrs (old: {
  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ python3 ];

  postPatch = (old.postPatch or "") + ''
    python3 << 'PYEOF'
    with open('adapters/opencode/peon-ping.ts', 'r') as f:
        src = f.read()

    # Replace naive slash-swap with wslpath -w + URI normalisation.
    # The if (isWSL) { guard on the line above is intentionally untouched.
    src = src.replace(
        r'const wpath = filePath.replace(/\//g, "\\")',
        'const wpath = require("child_process").execSync(`wslpath -w "''${filePath}"`, { encoding: "utf8", timeout: 5000 }).toString().trim();\n      const uriPath = wpath.replace(/\\\\/g, "/");'
    )

    # Update the PowerShell Open call to use the URI-safe path.
    src = src.replace(
        "$p.Open([Uri]::new('file:///''${wpath}'))",
        "$p.Open([Uri]::new('file:///''${uriPath}'))"
    )

    with open('adapters/opencode/peon-ping.ts', 'w') as f:
        f.write(src)
    PYEOF
  '';
})
