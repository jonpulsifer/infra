# Adapted from https://github.com/nix-community/home-manager/pull/8750
# Vendored locally until the upstream PR is merged.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.peon-ping;
  jsonFormat = pkgs.formats.json { };

  defaultOgPacksSource = pkgs.fetchFromGitHub {
    owner = "PeonPing";
    repo = "og-packs";
    rev = "v1.2.0";
    hash = "sha256-UZ6F70VBEDLzgFF3py1f5qKxgKbYPmSikXFgo8fRo8M=";
  };

  hookCommand = "${cfg.package}/bin/peon";
  adapterDir = "${cfg.package}/lib/peon-ping/adapters";

  hookEntry = event: {
    matcher = "";
    hooks = [
      (
        {
          type = "command";
          command = hookCommand;
          timeout = 10;
        }
        // lib.optionalAttrs (event != "SessionStart") { async = true; }
      )
    ];
  };

  claudeCodeHooks = lib.listToAttrs (
    map (event: lib.nameValuePair event [ (hookEntry event) ]) cfg.claudeCodeHookEvents
  );

  claudeCodeHooksJson = builtins.toJSON claudeCodeHooks;
in
{
  options.programs.peon-ping = {
    enable = lib.mkEnableOption "peon-ping, a notification sound player for AI coding agents";

    package = lib.mkPackageOption pkgs "peon-ping" { };

    settings = lib.mkOption {
      inherit (jsonFormat) type;
      default = { };
      example = {
        active_pack = "peon";
        volume = 0.5;
        enabled = true;
        desktop_notifications = true;
        categories = {
          "session.start" = true;
          "task.complete" = true;
          "input.required" = true;
        };
      };
      description = ''
        Declarative peon-ping configuration written to
        {file}`~/.claude/hooks/peon-ping/config.json`.

        When non-empty, the config file is managed by Home Manager as an
        immutable symlink. When left empty (the default), a mutable default
        config is seeded on first activation so that the `peon` CLI and
        Claude Code skills can modify it at runtime.
      '';
    };

    packs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "peon" ];
      example = [
        "peon"
        "peon_de"
        "aoe2"
      ];
      description = ''
        Sound pack names to install from {option}`ogPacksSource`.
        Each name corresponds to a subdirectory in the og-packs repository.
      '';
    };

    ogPacksSource = lib.mkOption {
      type = lib.types.package;
      default = defaultOgPacksSource;
      defaultText = lib.literalExpression ''
        pkgs.fetchFromGitHub {
          owner = "PeonPing";
          repo = "og-packs";
          rev = "v1.2.0";
          hash = "sha256-UZ6F70VBEDLzgFF3py1f5qKxgKbYPmSikXFgo8fRo8M=";
        }
      '';
      description = ''
        Source derivation containing sound packs. Pack names in
        {option}`packs` are resolved as subdirectories of this source.
      '';
    };

    enableClaudeCodeIntegration = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether to automatically configure Claude Code hooks for
        peon-ping integration via an activation script.
      '';
    };

    enableGeminiIntegration = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether to automatically configure Gemini CLI hooks for
        peon-ping integration via an activation script.
      '';
    };

    claudeCodeHookEvents = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "SessionStart"
        "SessionEnd"
        "UserPromptSubmit"
        "Stop"
        "Notification"
        "PermissionRequest"
      ];
      description = ''
        Claude Code hook events to register peon-ping for.
        Each event fires the `peon` command which reads the event
        from stdin and plays the appropriate sound.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    home.file = {
      ".claude/hooks/peon-ping/config.json" = lib.mkIf (cfg.settings != { }) {
        source = jsonFormat.generate "peon-ping-config.json" cfg.settings;
      };
    };

    # Copy packs as real files (not symlinks) so peon's path traversal
    # check (os.path.realpath + startswith) doesn't reject nix store paths.
    # Also symlink peon.sh into the hooks dir so `peon status` detects the
    # Claude Code integration as "installed".
    home.activation.installPeonPingPacks = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      peonDir="''${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/peon-ping"
      packsDir="$peonDir/packs"
      run mkdir -p "$packsDir"
      ${lib.concatMapStringsSep "\n" (name: ''
        if [ -L "$packsDir/${name}" ]; then
          run rm "$packsDir/${name}"
        fi
        run rm -rf "$packsDir/${name}"
        run cp -rL "${cfg.ogPacksSource}/${name}" "$packsDir/${name}"
        run chmod -R u+w "$packsDir/${name}"
      '') cfg.packs}
      # peon status checks for peon.sh and adapters/ in the hooks dir
      run ln -sf "${cfg.package}/lib/peon-ping/peon.sh" "$peonDir/peon.sh"
      run ln -sfn "${adapterDir}" "$peonDir/adapters"
      verboseEcho "Installed peon-ping packs: ${lib.concatStringsSep ", " cfg.packs}"
    '';

    # Seed a mutable default config when no declarative settings are provided
    home.activation.seedPeonPingConfig = lib.mkIf (cfg.settings == { }) (
      lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        peonConfigDir="''${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/peon-ping"
        peonConfigFile="$peonConfigDir/config.json"
        if [ ! -f "$peonConfigFile" ]; then
          run mkdir -p "$peonConfigDir"
          run cp "${cfg.package}/lib/peon-ping/config.json" "$peonConfigFile"
          run chmod u+w "$peonConfigFile"
          verboseEcho "Seeded peon-ping default config at $peonConfigFile"
        fi
      ''
    );

    # Merge peon-ping hooks into Claude Code settings.json
    home.activation.claudeCodePeonPingHooks = lib.mkIf cfg.enableClaudeCodeIntegration (
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        CLAUDE_SETTINGS="$HOME/.claude/settings.json"
        PEON_HOOKS='${claudeCodeHooksJson}'

        if [ -f "$CLAUDE_SETTINGS" ]; then
          ${pkgs.jq}/bin/jq --argjson peon "$PEON_HOOKS" '
            .hooks as $existing |
            reduce ($peon | keys[]) as $event (.; .hooks[$event] = (($existing[$event] // []) + $peon[$event]))
          ' "$CLAUDE_SETTINGS" > "$CLAUDE_SETTINGS.tmp" && mv "$CLAUDE_SETTINGS.tmp" "$CLAUDE_SETTINGS"
        else
          mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
          echo '{"hooks": '"$PEON_HOOKS"'}' | ${pkgs.jq}/bin/jq . > "$CLAUDE_SETTINGS"
        fi
      ''
    );

    # Merge peon-ping hooks into Gemini CLI settings.json
    home.activation.geminiPeonPingHooks = lib.mkIf cfg.enableGeminiIntegration (
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        GEMINI_SETTINGS="''${GEMINI_CONFIG_DIR:-$HOME/.gemini}/settings.json"
        ADAPTER="$HOME/.claude/hooks/peon-ping/adapters/gemini.sh"

        # Build hooks JSON with the resolved adapter path
        GEMINI_HOOKS=$(${pkgs.jq}/bin/jq -n \
          --arg adapter "$ADAPTER" \
          '{
            SessionStart: [{matcher: "startup", type: "command", command: ("bash " + $adapter + " SessionStart")}],
            AfterAgent:   [{matcher: "*", type: "command", command: ("bash " + $adapter + " AfterAgent")}],
            AfterTool:    [{matcher: "*", type: "command", command: ("bash " + $adapter + " AfterTool")}],
            Notification: [{matcher: "*", type: "command", command: ("bash " + $adapter + " Notification")}]
          }')

        if [ -f "$GEMINI_SETTINGS" ]; then
          ${pkgs.jq}/bin/jq --argjson peon "$GEMINI_HOOKS" '.hooks = $peon' \
            "$GEMINI_SETTINGS" > "$GEMINI_SETTINGS.tmp" && mv "$GEMINI_SETTINGS.tmp" "$GEMINI_SETTINGS"
        else
          mkdir -p "$(dirname "$GEMINI_SETTINGS")"
          echo '{}' | ${pkgs.jq}/bin/jq --argjson peon "$GEMINI_HOOKS" '.hooks = $peon' > "$GEMINI_SETTINGS"
        fi
      ''
    );
  };
}
