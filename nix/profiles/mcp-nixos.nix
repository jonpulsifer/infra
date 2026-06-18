# mcp-nixos profile — MCP server for NixOS package/option lookups
#
# Provides the `mcp-nixos` CLI so AI clients (Rowbutt, pi coding agent, etc.)
# can query real NixOS packages, options, Home Manager, flakes, and more —
# no more hallucinated attribute names.
#
# Also writes ~/.pi/agent/mcp.json so the `pi` coding agent picks it up
# automatically on hosts where the jawn user exists.
{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  inherit (lib) mkIf;
  jawn = config.users.users.jawn or null;

  # Static MCP client config — written at build time via pkgs.writeText,
  # then copied to ~/.pi/agent/ at activation so pi picks it up automatically.
  piMcpConfig = pkgs.writeText "mcp.json" (builtins.toJSON {
    mcpServers = {
      nixos = {
        command = "uvx";
        args = [ "mcp-nixos" ];
      };
    };
  });
in
mkIf config.programs.mcp-nixos.enable {
  environment.systemPackages = [
    inputs.mcp-nixos.packages.${pkgs.system}.mcp-nixos
  ];

  system.activationScripts.setup-pi-mcp-config = mkIf (jawn != null) {
    deps = [ "users" ];
    text = ''
      _pi_dir="${jawn.home}/.pi/agent"
      mkdir -p "$_pi_dir"
      cp ${piMcpConfig} "$_pi_dir/mcp.json"
      chmod 600 "$_pi_dir/mcp.json"
      chown ${toString jawn.uid} ${toString jawn.uid} "$_pi_dir/mcp.json"
    '';
  };
}
