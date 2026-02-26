{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    concatStringsSep
    foldl'
    mapAttrs
    mapAttrs'
    nameValuePair
    ;

  jsonFormat = pkgs.formats.json { };
  mcpServers = config.ai.mcpServers;

  # opencode format: { "mcp": { "name": { "type": "local", "command": [...] } } }
  opencodeConfig = {
    "$schema" = "https://opencode.ai/config.json";
    mcp = mapAttrs (
      _: server:
      if server ? url then
        {
          type = "remote";
          url = server.url;
        }
      else
        {
          type = "local";
          command = [ server.command ] ++ server.args;
        }
    ) mcpServers;
    plugin = lib.optionals config.programs.peon-ping.enableOpenCodeIntegration [
      "./plugins/peon-ping.ts"
    ];
  };

  # Cursor/Gemini format: { "mcpServers": { "name": { "command": "...", "args": [...] } } }
  cursorMcpConfig = {
    mcpServers = mcpServers;
  };

  geminiMcpConfig = {
    mcpServers = mcpServers;
    # preserve existing auth settings
    security.auth.selectedType = "oauth-personal";
  };

  # Claude Code: mcpServers merged into ~/.claude.json via activation script
  claudeCodeMcpServersJson = builtins.toJSON mcpServers;

  # Single source of truth for AI assistant context
  context = {
    name = config.home.username;

    role = "Security Engineer";
    focus = "Cloud and Infrastructure Security";

    languages = [
      "nix"
      "go"
      "typescript"
      "python"
      "rust"
    ];

    tools = [
      "kubernetes"
      "terraform"
      "gcp"
      "git"
      "tmux"
      "docker"
      "home-manager"
    ];

    interests = [
      "cloud-security"
      "infrastructure-security"
      "platform-engineering"
      "automation"
      "infrastructure-as-code"
    ];

    preferences = {
      style = "concise and direct";
      formatting = "use markdown, prefer code examples";
      commits = "conventional commits, signed, with DCO sign-off (-s)";
      testing = "write tests for new functionality";
      prs = "NEVER commit to main/master/default branch. Always prefer PRs against main using gh CLI, monitor for ci/cd pipelines";
    };
  };

  # Agent Skills standard format (SKILL.md with YAML frontmatter)
  # https://agentskills.io
  personalSkill = ''
    ---
    name: personal-context
    description: Personal coding preferences and context for ${context.name}. Use when you need to understand my background, preferred languages, tools, and coding style.
    ---

    # About Me

    I'm ${context.name}, a ${context.role} focused on ${context.focus}.

    My interests include ${concatStringsSep ", " context.interests}.

    ## Languages
    ${concatStringsSep "\n    " (map (l: "- ${l}") context.languages)}

    ## Tools & Technologies
    ${concatStringsSep "\n    " (map (t: "- ${t}") context.tools)}

    ## Preferences
    - Communication: ${context.preferences.style}
    - ${context.preferences.formatting}
    - Git: ${context.preferences.commits}
    - PRs: ${context.preferences.prs}
    - ${context.preferences.testing}

    ## Review Process

    After making changes, spawn subagents to review:
    1. **security-review** - audit security configurations and vulnerabilities
    2. **code-review** - verify functionality and correctness
    3. **lint-format** - check style, linting, and formatting
  '';

  securityReviewSkill = builtins.readFile ./skills/security-review.md;
  codeReviewSkill = builtins.readFile ./skills/code-review.md;
  lintFormatSkill = builtins.readFile ./skills/lint-format.md;
  prSkill = builtins.readFile ./skills/submit-pr.md;
  prCommand = builtins.readFile ./commands/pr.md;

  # Nix-managed skills distributed to ~/.agents/skills/, ~/.claude/skills/, ~/.config/opencode/skills/
  skills = {
    "personal-context" = personalSkill;
    "submit-pr" = prSkill;
    "security-review" = securityReviewSkill;
    "code-review" = codeReviewSkill;
    "lint-format" = lintFormatSkill;
  };

  homeDir = config.home.homeDirectory;

  # Write each skill once to ~/.agents/skills/{name}/SKILL.md
  canonicalSkillFiles = mapAttrs' (
    name: text: nameValuePair ".agents/skills/${name}/SKILL.md" { inherit text; }
  ) skills;

  agentSkillsScript = pkgs.writeShellScriptBin "agent-skills" (
    builtins.readFile ./scripts/agent-skills.sh
  );

  statuslineScript = builtins.readFile ./scripts/statusline.sh;

  claudeSkillFiles = mapAttrs' (
    name: text: nameValuePair ".claude/skills/${name}/SKILL.md" { inherit text; }
  ) skills;

  opencodeSkillFiles = mapAttrs' (
    name: text: nameValuePair "opencode/skills/${name}/SKILL.md" { inherit text; }
  ) skills;

in
{
  options.ai.claudeCode.settings = lib.mkOption {
    type = lib.types.attrsOf jsonFormat.type;
    default = { };
    description = "Settings merged into ~/.claude/settings.json on activation.";
  };

  options.ai.mcpServers = lib.mkOption {
    type = lib.types.attrsOf jsonFormat.type;
    default = {
      nixos = {
        command = "docker";
        args = [
          "run"
          "--rm"
          "-i"
          "ghcr.io/utensils/mcp-nixos"
        ];
      };
      gcloud = {
        command = "npx";
        args = [
          "-y"
          "@google-cloud/gcloud-mcp"
        ];
      };
      terraform = {
        command = "docker";
        args = [
          "run"
          "-i"
          "--rm"
          "hashicorp/terraform-mcp-server"
        ];
      };
      shadcn = {
        command = "npx";
        args = [
          "shadcn@latest"
          "mcp"
        ];
      };
    };
    description = "MCP server definitions fanned out to all AI agent configs.";
  };

  config.home.packages =
    with pkgs.llm-agents;
    [
      claude-code
      cursor-agent
      opencode
      gemini-cli
    ]
    ++ [ agentSkillsScript ];

  config.ai.claudeCode.settings.statusLine = {
    type = "command";
    command = "${homeDir}/.claude/statusline.sh";
  };

  # Canonical skills in ~/.agents/skills/, Claude skills in ~/.claude/skills/
  config.home.file =
    canonicalSkillFiles
    // claudeSkillFiles
    // {
      ".cursor/mcp.json".text = builtins.toJSON cursorMcpConfig;
      ".claude/statusline.sh" = {
        text = statuslineScript;
        executable = true;
      };
    };

  config.xdg.configFile = opencodeSkillFiles // {
    "opencode/opencode.json".text = builtins.toJSON opencodeConfig;
    "opencode/commands/pr.md".text = prCommand;
  };

  # Claude Code: merge mcpServers into ~/.claude.json (can't overwrite, file has runtime state)
  config.home.activation.claudeCodeMcp = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    CLAUDE_CONFIG="$HOME/.claude.json"
    MCP_SERVERS='${claudeCodeMcpServersJson}'

    if [ -f "$CLAUDE_CONFIG" ]; then
      ${pkgs.jq}/bin/jq --argjson servers "$MCP_SERVERS" '.mcpServers = $servers' \
        "$CLAUDE_CONFIG" > "$CLAUDE_CONFIG.tmp" && mv "$CLAUDE_CONFIG.tmp" "$CLAUDE_CONFIG"
    else
      echo "{\"mcpServers\": $MCP_SERVERS}" > "$CLAUDE_CONFIG"
    fi
  '';

  # Claude Code: merge managed settings into ~/.claude/settings.json
  config.home.activation.claudeCodeSettings =
    let
      settingsJson = builtins.toJSON config.ai.claudeCode.settings;
    in
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      CLAUDE_SETTINGS="$HOME/.claude/settings.json"
      NEW_SETTINGS='${settingsJson}'

      if [ -f "$CLAUDE_SETTINGS" ]; then
        ${pkgs.jq}/bin/jq --argjson new "$NEW_SETTINGS" '. * $new' \
          "$CLAUDE_SETTINGS" > "$CLAUDE_SETTINGS.tmp" && mv "$CLAUDE_SETTINGS.tmp" "$CLAUDE_SETTINGS"
      else
        mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
        echo "$NEW_SETTINGS" > "$CLAUDE_SETTINGS"
      fi
    '';

}
