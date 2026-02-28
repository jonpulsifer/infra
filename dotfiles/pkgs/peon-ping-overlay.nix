# Wraps the upstream peon-ping flake package with our WSL fix for the OpenCode
# adapter (file:// URI path handling). Packs install and integrations remain
# in home/modules/peon-ping.nix.
{
  upstreamPeonPing,
}:
upstreamPeonPing.overrideAttrs (old: {
  postPatch =
    (old.postPatch or "")
    + ''
      # Fix WSL audio path handling - file:// URI needs forward slashes, not backslashes.
      # Use wslpath to convert WSL paths to Windows paths, then forward slashes for URI.
      dollar='$'
      sed -i '468s|.*|      const wslPath = require("child_process").execSync(`wslpath -w "''${dollar}{filePath}"`, { encoding: "utf8", timeout: 5000 }).toString().trim();|' adapters/opencode/peon-ping.ts
      sed -i '468a\      const uriPath = wslPath.replace(/\\\\/g, "/")' adapters/opencode/peon-ping.ts
      sed -i '473s/wpath/uriPath/' adapters/opencode/peon-ping.ts
    '';
})
