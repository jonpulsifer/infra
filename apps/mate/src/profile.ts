/**
 * The system prompt: a short mate preamble, the repo's AGENTS.md and an index
 * of its skills, read from mate's own copy of the repo once per process. The
 * skills' locations point into the sandbox's checkout, where the model reads
 * them with its tools.
 */
import { resolve } from 'node:path';
import {
  BACKGROUND_CONTEXT,
  formatSkillsForSystemPrompt,
  loadSkills,
  type Skill,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import type {
  LoadSystemPrompts,
  ProfileOptions,
  SystemPrompts,
} from './brain-inputs.ts';
import type { Log } from './log.ts';
import type { SurfaceName } from './surface.ts';

/** Later directories win a duplicate skill name. */
export const SKILL_DIRS = ['dotfiles/skills', '.agents/skills'] as const;
export const AGENTS_FILE = 'AGENTS.md';

const SURFACES: Record<SurfaceName, string> = {
  discord: 'Discord',
  slack: 'Slack',
};

export const loadSystemPrompts: LoadSystemPrompts = async (options) => {
  const root = resolve(options.root);
  const env = new NodeExecutionEnv({ cwd: root });
  const [agents, skills] = await Promise.all([
    readAgents(env, root, options.log),
    skillsIndex(env, root, options),
  ]);
  const prompt = (surface: SurfaceName) =>
    [
      preamble(SURFACES[surface], options),
      agents && `# Repository instructions (AGENTS.md)\n\n${agents}`,
      skills,
    ]
      .filter(Boolean)
      .join('\n\n');
  return {
    discord: prompt('discord'),
    slack: prompt('slack'),
  } satisfies SystemPrompts;
};

function preamble(
  surface: string,
  { workspace, checkoutRef }: ProfileOptions,
): string {
  return `You are Rowbutt, the owner's coding and operations agent for this homelab, answering in a ${surface} thread. Your replies post to the thread as Markdown; keep them short.

Your tools run in this thread's own sandbox, a Kata microVM on the offsite cluster, with the infra repository checked out at ${workspace} at \`${checkoutRef}\`. The sandbox starts on your first tool call, which can take a minute, so answer a question that needs no files or commands without tools.

- Credentials (git push, kubectl for the offsite and folly contexts, and ssh) exist only while a turn runs.
- Background processes do not survive the end of the turn.
- The sandbox and its uncommitted work are deleted when the thread goes quiet or another thread needs the slot. Commit and push work worth keeping before the turn ends. When that happens, mate says so at the start of the next message.
- A mate restart can interrupt a running command. Its result then says it was interrupted and its outcome is unknown, so check what it did before you run it again.
- Nix work runs on the site's build host: \`ssh riptide.lolwtf.ca\` for folly, \`ssh oldschool.lolwtf.ca\` for offsite.
- Check a change with \`mise run format:check && mise run lint\`, not \`mise run check\`, which needs pwsh.
- The \`kthx_*\` tools, when listed, act on kthx built apps.`;
}

async function readAgents(
  env: NodeExecutionEnv,
  root: string,
  log: Log,
): Promise<string | null> {
  const path = `${root}/${AGENTS_FILE}`;
  const text = await env.readTextFile(path, BACKGROUND_CONTEXT);
  if (text.ok && text.value.trim()) return text.value.trim();
  log.warn('profile file missing', {
    path,
    error: text.ok ? 'the file is empty' : text.error.message,
  });
  return null;
}

async function skillsIndex(
  env: NodeExecutionEnv,
  root: string,
  { workspace, log }: ProfileOptions,
): Promise<string> {
  const dirs = SKILL_DIRS.map((dir) => `${root}/${dir}`);
  let loaded: Skill[] = [];
  try {
    const result = await loadSkills(env, dirs, BACKGROUND_CONTEXT);
    for (const diagnostic of result.diagnostics) {
      log.warn('skill diagnostic', {
        code: diagnostic.code,
        path: diagnostic.path,
        error: diagnostic.message,
      });
    }
    loaded = result.skills;
  } catch (error) {
    log.warn('skills not loaded', { root, error: String(error) });
  }
  // loadSkills says nothing about a directory that is missing or empty.
  for (const dir of dirs) {
    if (!loaded.some((skill) => skill.filePath.startsWith(`${dir}/`))) {
      log.warn('profile file missing', {
        path: dir,
        error: 'the directory holds no skills',
      });
    }
  }
  const byName = new Map<string, Skill>();
  for (const skill of loaded) {
    const filePath = inWorkspace(skill.filePath, root, workspace);
    const earlier = byName.get(skill.name);
    if (earlier) {
      log.warn('duplicate skill name', {
        name: skill.name,
        kept: filePath,
        dropped: earlier.filePath,
      });
    }
    byName.set(skill.name, { ...skill, filePath });
  }
  return formatSkillsForSystemPrompt([...byName.values()]);
}

function inWorkspace(path: string, root: string, workspace: string): string {
  return path.startsWith(`${root}/`)
    ? `${workspace}${path.slice(root.length)}`
    : path;
}
