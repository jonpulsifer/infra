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
      prs = "create PRs against main using gh CLI, monitor for ci/cd pipelines";
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

  securityReviewSkill = ''
    ---
    name: security-review
    description: Security audit subagent. Spawn this to review code changes for security vulnerabilities, misconfigurations, secrets exposure, and cloud security best practices. Use after making any infrastructure, configuration, or code changes.
    ---

    # Security Review

    You are a security-focused code reviewer. Audit changes for security issues.

    ## Checklist

    ### Secrets & Credentials
    - [ ] No hardcoded secrets, API keys, or passwords
    - [ ] No credentials in logs or error messages
    - [ ] Secrets use proper secret management (vault, sops, sealed-secrets)

    ### Infrastructure Security
    - [ ] Least privilege IAM roles and permissions
    - [ ] No overly permissive security groups or firewall rules
    - [ ] Encryption at rest and in transit enabled
    - [ ] No public exposure of internal services

    ### Cloud Security (GCP/AWS/Azure)
    - [ ] Service accounts follow least privilege
    - [ ] No wildcards in IAM policies
    - [ ] Audit logging enabled
    - [ ] Resource policies are restrictive
    - [ ] No long lived tokens or credentials

    ### Kubernetes Security
    - [ ] No privileged containers
    - [ ] Resource limits defined
    - [ ] Network policies in place
    - [ ] RBAC follows least privilege
    - [ ] No hostPath mounts unless necessary

    ### Code Security
    - [ ] Input validation present
    - [ ] No SQL injection or command injection vectors
    - [ ] Dependencies are up to date
    - [ ] No unsafe deserialization

    ## Output Format

    Report findings as:
    - 🔴 **Critical** - Must fix before merge
    - 🟠 **High** - Should fix before merge
    - 🟡 **Medium** - Fix soon
    - 🟢 **Low** - Consider improving
  '';

  codeReviewSkill = ''
    ---
    name: code-review
    description: Code review subagent for functionality and correctness. Spawn this to verify logic, error handling, test coverage, and that changes work as intended.
    ---

    # Code Review

    You are a code reviewer focused on functionality and correctness.

    ## Checklist

    ### Logic & Correctness
    - [ ] Logic is correct and handles edge cases
    - [ ] No obvious bugs or typos
    - [ ] Changes match the intended behavior
    - [ ] Error handling is comprehensive

    ### Code Quality
    - [ ] Functions are focused and appropriately sized
    - [ ] No code duplication
    - [ ] Clear naming for variables and functions
    - [ ] Comments explain "why" not "what"

    ### Testing
    - [ ] New code has test coverage
    - [ ] Tests cover happy path and error cases
    - [ ] Tests are not flaky
    - [ ] Integration points are tested

    ### Dependencies
    - [ ] New dependencies are justified
    - [ ] No unnecessary dependencies added
    - [ ] Dependencies are pinned appropriately

    ## Output Format

    Provide feedback as:
    - **Issues** - Problems that need fixing
    - **Suggestions** - Improvements to consider
    - **Questions** - Clarifications needed
  '';

  lintFormatSkill = ''
    ---
    name: lint-format
    description: Linting and formatting subagent. Spawn this to check code style, run linters, and ensure consistent formatting before committing.
    ---

    # Lint & Format

    You are a code style and formatting reviewer.

    ## Tasks

    1. **Check formatting** - Ensure code follows project style
    2. **Run linters** - Identify style violations
    3. **Fix issues** - Auto-fix where possible

    ## Language-Specific

    ### Nix
    ```bash
    nixfmt-rfc-style .
    # or
    nix fmt
    ```

    ### Go
    ```bash
    gofmt -w .
    go vet ./...
    golangci-lint run
    ```

    ### TypeScript/JavaScript
    ```bash
    npm run lint
    npm run format
    # or
    biome format --write .
    biome check .
    biome lint --fix .
    ```

    ### Python
    ```bash
    ruff check --fix .
    ruff format .
    # or
    black .
    isort .
    ```

    ### Terraform
    ```bash
    terraform fmt -recursive
    terraform validate
    ```

    ## Output Format

    Report:
    - Files modified by formatters
    - Linting errors that need manual fixes
    - Style inconsistencies found
  '';

  prSkill = ''
    ---
    name: submit-pr
    description: Create and submit a GitHub pull request. Use when the user wants to submit, create, or open a PR/pull request for their changes.
    ---

    # Submit Pull Request

    Create a well-structured GitHub pull request for the current changes.

    ## Prerequisites

    - Commits must be signed (GPG/SSH) and signed-off (DCO)
    - Use `git commit -s` to add DCO sign-off
    - Branch should be based on latest main

    ## Workflow

    1. **Sync with main**: Ensure branch is up to date
    2. **Check status**: Run `git status` and `git diff` to understand changes
    3. **Ensure committed**: All changes committed with sign-off (`-s`)
    4. **Push branch**: Push to remote with `git push -u origin HEAD`
    5. **Create PR**: Use `gh pr create` against main

    ## Commands

    ```bash
    # Ensure you're up to date with main
    git fetch origin
    git rebase origin/main

    # Check current state
    git status
    git log --oneline origin/main..HEAD

    # If you need to amend with sign-off
    git commit --amend -s --no-edit

    # Push and create PR
    git push -u origin HEAD
    gh pr create --base main --title "feat: description" --body "..."
    ```

    ## PR Format

    Use this structure for the PR body with `gh pr create`:

    ```bash
    gh pr create --base main --title "type: description" --body "$(cat <<'EOF'
    ## Summary
    Brief description of what this PR does (1-2 sentences)

    ## Changes
    - Bullet points of specific changes made

    ## Test Plan
    - [ ] How to verify this works

    Signed-off-by: Name <email>
    EOF
    )"
    ```

    ## Conventional Commits

    Use these prefixes for PR titles:
    - `feat:` new feature
    - `fix:` bug fix
    - `docs:` documentation
    - `refactor:` code restructuring
    - `chore:` maintenance tasks
  '';

  # opencode command for /pr
  prCommand = ''
    ---
    description: Create and submit a pull request
    ---

    Create a pull request for the current branch against main.

    First, check the current state:
    !`git fetch origin`
    !`git status`
    !`git log --oneline origin/main..HEAD 2>/dev/null || git log --oneline -5`

    Requirements:
    - All commits must be signed-off (DCO) with `git commit -s`
    - Branch should be rebased on latest origin/main
    - Use `gh pr create --base main` to create the PR

    Then:
    1. Check if commits have sign-off (look for "Signed-off-by:" in `git log`)
    2. If missing sign-off, amend with `git commit --amend -s --no-edit`
    3. Rebase on origin/main if needed: `git rebase origin/main`
    4. Push the branch: `git push -u origin HEAD`
    5. Create PR: `gh pr create --base main --title "type: description" --body "..."`
    6. Return the PR URL
  '';

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

  # Notifier plugin implementation
  notifierPlugin = {
    home.file.".config/opencode/plugins/notifier.ts".text = ''
      import { type Plugin } from "@opencode-ai/plugin"

      export const NotifierPlugin: Plugin = async ({ $, project }) => {
        return {
          event: async ({ event }) => {
            if (event.type === "session.idle") {
              const title = "OpenCode Task Complete";
              const message = `Project: ${project.name || 'Current Directory'}`;

              ${if pkgs.stdenv.isDarwin then ''
                // macOS Notification
                await $`osascript -e 'display notification "${message}" with title "${title}" sound name "Glass"'`;
              '' else ''
                // WSL/Linux Notification via PowerShell bridge
                await $`powershell.exe -Command "[System.Media.SystemSounds]::Asterisk.Play()"`.nothrow();
                const psCommand = `
                  [void] [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');
                  $notification = New-Object System.Windows.Forms.NotifyIcon;
                  $notification.Icon = [System.Drawing.SystemIcons]::Information;
                  $notification.BalloonTipTitle = ' ${title}';
                  $notification.BalloonTipText = ' ${message}';
                  $notification.Visible = $True;
                  $notification.ShowBalloonTip(5000);
                `;
                await $`powershell.exe -Command "${psCommand.replace(/\n/g, '')}"`.nothrow();
              ''}
  # Notifier plugin
  notifierPlugin;
}
          },
        }
      }
    '';

    # Ensure the base config loads local plugins
    xdg.configFile."opencode/opencode.json".text = builtins.toJSON {
      plugin = [ "./plugins/notifier.ts" ];
    };
  };
