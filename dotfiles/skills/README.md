# Agent skills

Personal agent skills that the dotfiles deploy links into each agent CLI's skills directory. Each skill is a directory with a `SKILL.md`.

## Add or change a skill

Create `<name>/SKILL.md` with `name` and `description` frontmatter. Start the description with "Use when" and name concrete triggers, in 1024 characters or fewer.

The skills pass work to each other through a gitignored context directory in the working repository, which each `SKILL.md` names. context-builder writes `context.md`, planner writes `plan.md`, and reviewer and submit-pr read them. The pi prompt aliases for these skills are in `dotfiles/pi/mate/prompts/`.

## Test

```bash
bun run --cwd apps/mate test
mise run --cd dotfiles dotfiles:check
```

mate indexes this directory into [Rowbutt](https://wiki.lolwtf.ca/apps/mate/)'s system prompt (`SKILL_DIRS` in `apps/mate/src/profile.ts`), the sandbox's checkout holds the files, and the `apps/mate` tests fail if it holds no `*/SKILL.md`. `dotfiles:check` prints each link the deploy would make and changes nothing.

## Deploy

`dotfiles/scripts/deploy-dotfiles.sh` links this directory to `~/.agents/skills`, `~/.claude/skills` and `~/.gemini/config/skills`. NixOS hosts run it on every activation through `nix/system/mise-dotfiles.nix`. On other machines, run `mise run --cd dotfiles bootstrap`.
