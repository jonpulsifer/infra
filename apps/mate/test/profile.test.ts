import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProfilePrompts, SystemPrompts } from '../src/brain-inputs.ts';
import { ConfigError } from '../src/config.ts';
import { createModelSetup } from '../src/model.ts';
import {
  AGENTS_FILE,
  brainProfiles,
  loadSystemPrompts,
  SKILL_DIRS,
} from '../src/profile.ts';
import {
  investigatorPreamble,
  operatorPreamble,
  PROFILES,
  type Profile,
} from '../src/profiles.ts';
import { RecordingLog } from './support.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = '/workspace';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const OPTIONS = { workspace: WORKSPACE, checkoutRef: 'main' };

/** `prompts` is operator's; `all` holds every profile's. */
async function load(root: string, log = new RecordingLog()) {
  const all = await loadSystemPrompts(
    { root, ...OPTIONS, log },
    PROFILES.values(),
  );
  return { prompts: all.operator as SystemPrompts, all, log };
}

function locations(prompt: string): string[] {
  return [...prompt.matchAll(/<location>([^<]*)<\/location>/g)].map(
    (m) => m[1]!,
  );
}

function skillFiles(root: string): string[] {
  return SKILL_DIRS.flatMap((dir) =>
    [...new Bun.Glob('*/SKILL.md').scanSync(join(root, dir))].map(
      (file) => `${dir}/${file}`,
    ),
  );
}

function each(prompts: SystemPrompts): [string, string][] {
  return Object.entries(prompts);
}

describe('the profile mate bakes into its image', () => {
  // A rename would leave the model without the repository's rules.
  test('has the instruction file', async () => {
    expect(await Bun.file(join(REPO, AGENTS_FILE)).exists()).toBe(true);
  });

  // loadSkills is silent about a directory that is missing or empty.
  test.each([...SKILL_DIRS])('holds skills in %s', (dir) => {
    const skills = [...new Bun.Glob('*/SKILL.md').scanSync(join(REPO, dir))];
    expect(skills.length).toBeGreaterThan(0);
  });
});

describe('loadSystemPrompts', () => {
  test('indexes every skill in both directories once, at its sandbox path', async () => {
    const { prompts, log } = await load(`${REPO}/`);
    const expected = skillFiles(REPO)
      .map((file) => `${WORKSPACE}/${file}`)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    for (const [, prompt] of each(prompts)) {
      expect(locations(prompt).sort()).toEqual(expected);
    }
    expect(log.of('duplicate skill name')).toEqual([]);
    expect(log.of('profile file missing')).toEqual([]);
  });

  test('includes AGENTS.md', async () => {
    const agents = (await Bun.file(join(REPO, AGENTS_FILE)).text()).trim();
    const { prompts } = await load(REPO);
    for (const [, prompt] of each(prompts)) {
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain(
        `# Repository instructions (AGENTS.md)\n\n${agents}`,
      );
    }
  });

  test('tells the model how its sandbox behaves, on both surfaces', async () => {
    const { prompts } = await load(REPO);
    expect(prompts.discord).toContain('answering in a Discord thread');
    expect(prompts.slack).toContain('answering in a Slack thread');
    for (const [, prompt] of each(prompts)) {
      for (const fact of [
        "this thread's own sandbox, a Kata microVM",
        'checked out at /workspace at `main`',
        'The sandbox starts on your first tool call',
        'exist only while a turn runs',
        'Background processes do not survive the end of the turn',
        'Commit and push work worth keeping before the turn ends',
        'mate says so at the start of the next message',
        'its outcome is unknown, so check what it did before you run it again',
        '`ssh riptide.lolwtf.ca` for folly, `ssh oldschool.lolwtf.ca` for offsite',
        '`mise run format:check && mise run lint`, not `mise run check`',
        'The `kthx_*` tools, when listed, act on kthx built apps',
      ]) {
        expect(prompt).toContain(fact);
      }
    }
  });

  test('a missing root gives the preamble alone, and logs it', async () => {
    const root = join(tmpdir(), `mate-profile-missing-${Date.now()}`);
    const { all, log } = await load(root);
    for (const prompts of Object.values(all)) {
      for (const [, prompt] of each(prompts)) {
        expect(prompt.startsWith('You are Rowbutt')).toBe(true);
        expect(prompt).not.toContain('# Repository instructions');
        expect(prompt).not.toContain('<available_skills>');
      }
    }
    const missing = log.of('profile file missing').map((e) => e.fields?.path);
    expect(missing.sort()).toEqual(
      [AGENTS_FILE, ...SKILL_DIRS].map((file) => `${root}/${file}`).sort(),
    );
  });

  test('a skills directory with no skills is logged, and the other still indexes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mate-profile-'));
    dirs.push(root);
    writeFileSync(join(root, AGENTS_FILE), 'Rules.\n');
    mkdirSync(join(root, 'dotfiles/skills'), { recursive: true });
    mkdirSync(join(root, '.agents/skills/deploy'), { recursive: true });
    writeFileSync(
      join(root, '.agents/skills/deploy/SKILL.md'),
      '---\nname: deploy\ndescription: Deploy it.\n---\n\nSteps.\n',
    );

    const { prompts, log } = await load(root);
    expect(locations(prompts.slack)).toEqual([
      `${WORKSPACE}/.agents/skills/deploy/SKILL.md`,
    ]);
    expect(log.of('profile file missing').map((e) => e.fields?.path)).toEqual([
      `${root}/dotfiles/skills`,
    ]);
  });

  test('a skill name in both directories keeps the .agents/skills one, with a warning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mate-profile-'));
    dirs.push(root);
    for (const dir of SKILL_DIRS) {
      mkdirSync(join(root, dir, 'deploy'), { recursive: true });
      writeFileSync(
        join(root, dir, 'deploy', 'SKILL.md'),
        `---\nname: deploy\ndescription: Deploy from ${dir}.\n---\n\nSteps.\n`,
      );
    }
    writeFileSync(join(root, AGENTS_FILE), 'Rules.\n');

    const { prompts, log } = await load(root);
    expect(locations(prompts.discord)).toEqual([
      `${WORKSPACE}/.agents/skills/deploy/SKILL.md`,
    ]);
    expect(prompts.discord).toContain('Deploy from .agents/skills.');
    expect(log.of('duplicate skill name')).toHaveLength(1);
    expect(log.of('profile file missing')).toEqual([]);
  });
});

describe('each profile', () => {
  test('has a prompt for both surfaces', async () => {
    const { all } = await load(REPO);
    expect(Object.keys(all).sort()).toEqual([
      'custodian',
      'investigator',
      'operator',
    ]);
    for (const prompts of Object.values(all)) {
      expect(Object.keys(prompts).sort()).toEqual(['discord', 'slack']);
    }
  });

  test('starts with its own preamble and shares AGENTS.md and the skills', async () => {
    const { all } = await load(REPO);
    const rest = (prompts: ProfilePrompts, id: string, preamble: string) => {
      const prompt = prompts[id]?.slack ?? '';
      expect(prompt.startsWith(preamble)).toBe(true);
      return prompt.slice(preamble.length);
    };
    const operator = rest(all, 'operator', operatorPreamble('Slack', OPTIONS));
    const investigator = rest(
      all,
      'investigator',
      investigatorPreamble('Slack', OPTIONS),
    );
    expect(investigator).toBe(operator);
    expect(investigator).toContain('# Repository instructions (AGENTS.md)');
    expect(investigator).toContain('<available_skills>');
    expect(all.custodian).toEqual(all.operator as SystemPrompts);
  });
});

describe('brainProfiles', () => {
  const setup = () =>
    createModelSetup({
      spec: 'opencode-go/qwen3.8-max',
      thinking: 'medium',
      keyFile: join(tmpdir(), 'mate-profile-no-key'),
      log: new RecordingLog(),
    });
  const prompts = (profiles: Iterable<Profile>): ProfilePrompts =>
    Object.fromEntries(
      [...profiles].map((profile) => [
        profile.id,
        {
          discord: `${profile.id} on Discord`,
          slack: `${profile.id} on Slack`,
        },
      ]),
    );

  test("resolves the process model and each profile's prompt and turn timeout", () => {
    const made = setup();
    const profiles = brainProfiles(made, prompts(PROFILES.values()), 2_700_000);
    expect([...profiles.keys()]).toEqual([...PROFILES.keys()]);
    const investigator = profiles.get('investigator');
    expect(investigator?.profile).toBe(PROFILES.get('investigator') as Profile);
    expect(investigator?.model).toBe(made.model);
    expect(investigator?.thinking).toBe('medium');
    expect(investigator?.prompts.slack).toBe('investigator on Slack');
    expect(investigator?.turnTimeoutMs).toBe(1_200_000);
    expect(profiles.get('operator')?.turnTimeoutMs).toBe(2_700_000);
    expect(profiles.get('custodian')?.turnTimeoutMs).toBe(2_700_000);
  });

  test("a profile's own model resolves from the catalog", () => {
    const made = setup();
    const own: Profile = {
      ...(PROFILES.get('operator') as Profile),
      model: { spec: 'opencode-go/minimax-m2.7', thinking: 'high' },
    };
    const profiles = brainProfiles(
      made,
      prompts([own]),
      60_000,
      new Map([[own.id, own]]),
    );
    expect(profiles.get('operator')?.model.id).toBe('minimax-m2.7');
    expect(profiles.get('operator')?.thinking).toBe('high');
  });

  test.each([
    ['opencode-go/no-such-model', 'medium', 'which pi-ai does not list'],
    ['qwen3.8-max', 'medium', 'must be'],
    ['opencode-go/qwen3.8-max', 'high', 'is not a level'],
  ] as const)('refuses a profile model %s at %s', (spec, thinking, why) => {
    const own: Profile = {
      ...(PROFILES.get('investigator') as Profile),
      model: { spec, thinking },
    };
    const run = () =>
      brainProfiles(setup(), prompts([own]), 60_000, new Map([[own.id, own]]));
    expect(run).toThrow(ConfigError);
    expect(run).toThrow('profile investigator');
    expect(run).toThrow(why);
  });

  test('refuses a profile with no prompt', () => {
    expect(() => brainProfiles(setup(), {}, 60_000)).toThrow(
      new ConfigError('profile operator has no system prompt'),
    );
  });
});
