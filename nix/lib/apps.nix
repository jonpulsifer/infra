{
  mkApps =
    {
      pkgs,
      hostsSpec,
      nixosConfigurations,
    }:
    let
      mkApp = name: text: {
        type = "app";
        program = "${(pkgs.writeShellScriptBin name text)}/bin/${name}";
      };

      # Filter out configurations that are images (profile == "images")
      realHosts = pkgs.lib.filterAttrs (_: config: (config.profile or "") != "images") hostsSpec;
      hostNames = builtins.attrNames realHosts;

      # Generic SSH runner: nix run . -- <command>
      # Runs on ALL hosts
      sshApp = mkApp "ssh" ''
        if [ -z "$1" ]; then
          echo "Usage: nix run . -- <command>"
          exit 1
        fi

        # Colors
        GREEN='\033[0;32m'
        NC='\033[0m' # No Color

        HOSTS="${builtins.concatStringsSep " " hostNames}"
        
        for HOST in $HOSTS; do
          # Run in background to parallelize? User example implied sequence or at least grouped output.
          # Sequential is cleaner for reading.
          
          # We use a subshell and sed to prefix output
          # ssh -q: quiet mode
          # -o ConnectTimeout=5: timeout after 5 seconds
          # -t: force pseudo-terminal (might mess up prefixing if not careful, but needed for some interactive commands)
          # However, for "nix run .# date", we probably don't need -t if we want to capture output.
          # But if user runs "top", they need -t.
          # Let's try without -t for the "run on all" case as it's likely for batch commands.
          # If they want interactive, they should use the single host app.
          
          ${pkgs.openssh}/bin/ssh -q -o ConnectTimeout=5 "$HOST.pirate-musical.ts.net" "$@" 2>&1 | \
            while IFS= read -r line; do
              echo -e "''${GREEN}[$HOST]:''${NC} $line"
            done
        done
      '';

      # Host specific runners: nix run .#<host> -- <command>
      hostApps = builtins.mapAttrs (name: _: mkApp "ssh-${name}" ''
        exec ${pkgs.openssh}/bin/ssh -o ConnectTimeout=5 -t "${name}.pirate-musical.ts.net" "$@"
      '') realHosts;
    in
    {
      default = sshApp;
    } // hostApps;
}
