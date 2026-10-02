/**
 * Each profile's system prompt: its preamble, the repo's AGENTS.md and an
 * index of its skills, read from mate's own copy of the repo once per process.
 * The skills' locations point into the sandbox's checkout, where the model
 * reads them with its tools. `brainProfiles` resolves each profile's prompt,
 * model and turn timeout at boot.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  BrainProfile,
  LoadSystemPrompts,
  ModelSetup,
  ProfileOptions,
  ProfilePrompts,
  SystemPrompts,
} from './brain-inputs.ts';
import { ConfigError } from './config.ts';
import { type Log, plain } from './log.ts';
import { profileModel } from './model.ts';
import { PROFILES, type Profile, turnTimeoutMs } from './profiles.ts';
import {
  formatSkillsForSystemPrompt,
  loadSkills,
  type Skill,
} from './skills.ts';
import type { SurfaceName } from './surface.ts';

/** Later directories win a duplicate skill name. */
export const SKILL_DIRS = ['dotfiles/skills', '.agents/skills'] as const;
export const AGENTS_FILE = 'AGENTS.md';

const SURFACES: Record<SurfaceName, string> = {
  discord: 'Discord',
  slack: 'Slack',
};

export const loadSystemPrompts: LoadSystemPrompts = async (
  options,
  profiles,
) => {
  const root = resolve(options.root);
  const [agents, skills] = await Promise.all([
    readAgents(root, options.log),
    skillsIndex(root, options),
  ]);
  const prompt = (profile: Profile, surface: SurfaceName) =>
    [
      profile.preamble(SURFACES[surface], options),
      agents && `# Repository instructions (AGENTS.md)\n\n${agents}`,
      skills,
    ]
      .filter(Boolean)
      .join('\n\n');
  return Object.fromEntries(
    [...profiles].map((profile) => [
      profile.id,
      {
        discord: prompt(profile, 'discord'),
        slack: prompt(profile, 'slack'),
      } satisfies SystemPrompts,
    ]),
  );
};

/** ConfigError for a profile model the catalog lacks, or a thinking level it does not support. */
export function brainProfiles(
  setup: ModelSetup,
  prompts: ProfilePrompts,
  processMs: number,
  profiles: ReadonlyMap<string, Profile> = PROFILES,
): ReadonlyMap<string, BrainProfile> {
  return new Map(
    [...profiles.values()].map((profile) => {
      const own = prompts[profile.id];
      if (!own) {
        throw new ConfigError(`profile ${profile.id} has no system prompt`);
      }
      const model = profile.model
        ? profileModel(
            setup,
            `profile ${profile.id}`,
            profile.model.spec,
            profile.model.thinking,
          )
        : { model: setup.model, thinking: setup.thinking };
      return [
        profile.id,
        {
          profile,
          prompts: own,
          ...model,
          turnTimeoutMs: turnTimeoutMs(profile, processMs),
        },
      ];
    }),
  );
}

async function readAgents(root: string, log: Log): Promise<string | null> {
  const path = `${root}/${AGENTS_FILE}`;
  let error = 'the file is empty';
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (text) return text;
  } catch (cause) {
    error = plain(cause);
  }
  log.warn('profile file missing', { path, error });
  return null;
}

async function skillsIndex(
  root: string,
  { workspace, log }: ProfileOptions,
): Promise<string> {
  const dirs = SKILL_DIRS.map((dir) => `${root}/${dir}`);
  let loaded: Skill[] = [];
  try {
    const result = await loadSkills(dirs);
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
