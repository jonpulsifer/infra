{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) concatStringsSep mapAttrs;

  # Single source of truth for MCP servers
  mcpServers = {
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

  # opencode format: { "mcp": { "name": { "type": "local", "command": [...] } } }
  opencodeConfig = {
    "$schema" = "https://opencode.ai/config.json";
    mcp = mapAttrs (_: server: {
      type = "local";
      command = [ server.command ] ++ server.args;
    }) mcpServers;
    plugin = [ "./plugins/notifier.ts" ];
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

in
{
  home.packages = with pkgs.unstable; [
    opencode
    gemini-cli-bin
  ];

  # opencode config, skills, and commands (primary tool)
  xdg.configFile."opencode/opencode.json".text = builtins.toJSON opencodeConfig;
  xdg.configFile."opencode/skills/personal-context/SKILL.md".text = personalSkill;
  xdg.configFile."opencode/skills/submit-pr/SKILL.md".text = prSkill;
  xdg.configFile."opencode/skills/security-review/SKILL.md".text = securityReviewSkill;
  xdg.configFile."opencode/skills/code-review/SKILL.md".text = codeReviewSkill;
  xdg.configFile."opencode/skills/lint-format/SKILL.md".text = lintFormatSkill;
  xdg.configFile."opencode/commands/pr.md".text = prCommand;

  # Cursor skills and MCP config
  home.file.".cursor/mcp.json".text = builtins.toJSON cursorMcpConfig;
  home.file.".cursor/skills/personal-context/SKILL.md".text = personalSkill;
  home.file.".cursor/skills/submit-pr/SKILL.md".text = prSkill;
  home.file.".cursor/skills/security-review/SKILL.md".text = securityReviewSkill;
  home.file.".cursor/skills/code-review/SKILL.md".text = codeReviewSkill;
  home.file.".cursor/skills/lint-format/SKILL.md".text = lintFormatSkill;

  # Notifier plugin configuration
  xdg.configFile."opencode/plugins/notifier.ts".source = ./plugins/notifier.ts;
}
