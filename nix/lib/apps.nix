# `nix run` entry points for reaching the fleet over the tailnet.
#
#   nix run .        -- uptime      run on every deploy host, output prefixed
#   nix run .#forge  -- journalctl  one host, with a pty
#
# Both resolve hosts through MagicDNS, so they only work from a machine on the
# tailnet.
{
  mkApps =
    { pkgs, deployHosts }:
    let
      fleet = import ./fleet.nix;

      mkApp = name: text: {
        type = "app";
        program = "${(pkgs.writeShellScriptBin name text)}/bin/${name}";
      };

      fanOut = mkApp "ssh" ''
        if [ -z "$1" ]; then
          echo "Usage: nix run . -- <command>"
          exit 1
        fi

        GREEN='\033[0;32m'
        NC='\033[0m'

        # Sequential and without a pty: this path is for batch commands whose
        # output is read afterwards. Use `nix run .#<host>` for anything
        # interactive.
        for HOST in ${builtins.concatStringsSep " " deployHosts}; do
          ${pkgs.openssh}/bin/ssh -q -o ConnectTimeout=5 "$HOST.${fleet.tailnet}" "$@" 2>&1 | \
            while IFS= read -r line; do
              echo -e "''${GREEN}[$HOST]:''${NC} $line"
            done
        done
      '';

      perHost = pkgs.lib.genAttrs deployHosts (
        name:
        mkApp "ssh-${name}" ''
          exec ${pkgs.openssh}/bin/ssh -o ConnectTimeout=5 -t "${name}.${fleet.tailnet}" "$@"
        ''
      );
    in
    {
      default = fanOut;
    }
    // perHost;
}
