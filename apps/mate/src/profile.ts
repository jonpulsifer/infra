/**
 * Each profile's system prompt: the shared persona, its preamble, the owner's
 * global AGENTS.md, its overrides of those rules, the repo's AGENTS.md and an
 * index of its skills, read from mate's own copy of the repo once per process.
 * The skills' locations point into the sandbox's checkout, where the model
 * reads them with its tools. `brainProfiles` resolves each profile's prompt,
 * model and turn timeout at boot.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  BrainProfile,
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
/** Shared with the owner's local pi package, so it holds no capability claims. */
export const PERSONA_FILE = 'dotfiles/pi/mate/persona.md';
export const OWNER_AGENTS_FILE = 'dotfiles/.agents/AGENTS.md';
/** Only when the persona file is missing or empty, so the model keeps an identity. */
export const FALLBACK_PERSONA =
  "You are Rowbutt, the owner's coding and operations agent for this homelab.";

const SURFACES: Record<SurfaceName, string> = {
  discord: 'Discord',
  slack: 'Slack',
};

/** Never rejects: a missing file is logged and left out, so mate still boots. */
export async function loadSystemPrompts(
  options: ProfileOptions,
  profiles: Iterable<Profile>,
): Promise<ProfilePrompts> {
  const root = resolve(options.root);
  const [persona, owner, agents, skills] = await Promise.all([
    readProfileFile(root, PERSONA_FILE, options.log),
    readProfileFile(root, OWNER_AGENTS_FILE, options.log),
    readProfileFile(root, AGENTS_FILE, options.log),
    skillsIndex(root, options),
  ]);
  const prompts = (profile: Profile): SystemPrompts => {
    const rules = owner && ownerRules(owner, profile, options.log);
    const prompt = (surface: SurfaceName) =>
      [
        persona ?? FALLBACK_PERSONA,
        profile.preamble(SURFACES[surface], options),
        rules &&
          `# Owner's standing instructions (global AGENTS.md)\n\n${rules}`,
        `# Overrides for this deployment\n\n${profile.overrides(profile.grants)}`,
        agents && `# Repository instructions (AGENTS.md)\n\n${agents}`,
        skills,
      ]
        .filter(Boolean)
        .join('\n\n');
    return { discord: prompt('discord'), slack: prompt('slack') };
  };
  return Object.fromEntries(
    [...profiles].map((profile) => [profile.id, prompts(profile)]),
  );
}

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

async function readProfileFile(
  root: string,
  file: string,
  log: Log,
): Promise<string | null> {
  const path = `${root}/${file}`;
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

/** The title, the Priority line and the profile's `## ` sections; a missing section is logged. */
function ownerRules(
  text: string,
  { id, ownerSections }: Profile,
  log: Log,
): string {
  if (!ownerSections) return text;
  const [head = '', ...sections] = text.split(/^(?=## )/m);
  const name = (section: string) =>
    (section.split('\n', 1)[0] ?? '').slice(3).trim();
  const found = new Set(sections.map(name));
  for (const section of ownerSections) {
    if (!found.has(section)) {
      log.warn('owner instructions section missing', { profile: id, section });
    }
  }
  return [head, ...sections.filter((s) => ownerSections.includes(name(s)))]
    .join('')
    .trim();
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
