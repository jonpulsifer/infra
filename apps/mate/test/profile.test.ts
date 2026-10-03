import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProfilePrompts, SystemPrompts } from '../src/brain-inputs.ts';
import { ConfigError } from '../src/config.ts';
import { createModelSetup } from '../src/model.ts';
import {
  AGENTS_FILE,
  brainProfiles,
  FALLBACK_PERSONA,
  loadSystemPrompts,
  OWNER_AGENTS_FILE,
  PERSONA_FILE,
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

const CONFIGURED = {
  github: true,
  vault: true,
  kube: { admin: true, reader: true },
};
const OPTIONS = {
  workspace: WORKSPACE,
  checkoutRef: 'main',
  configured: CONFIGURED,
};
const PROFILE_INPUTS = [
  PERSONA_FILE,
  OWNER_AGENTS_FILE,
  AGENTS_FILE,
  ...SKILL_DIRS,
];
const OWNER_HEADING = "# Owner's standing instructions (global AGENTS.md)";
const OVERRIDES_HEADING = '# Overrides for this deployment';
const REPO_HEADING = '# Repository instructions (AGENTS.md)';

async function repoText(file: string): Promise<string> {
  return (await Bun.file(join(REPO, file)).text()).trim();
}

/** The persona, the owner's file and AGENTS.md, but `without`. */
function writeProfileFiles(root: string, without?: string): void {
  const files: Record<string, string> = {
    [PERSONA_FILE]: 'You are Testbutt.\n',
    [OWNER_AGENTS_FILE]:
      '# Owner\n\nPriority.\n\n## Protect\n\n- Guard.\n\n## Communicate\n\n- Talk.\n',
    [AGENTS_FILE]: 'Rules.\n',
  };
  for (const [file, text] of Object.entries(files)) {
    if (file === without) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/** A root holding every profile input but `without`. */
function rootWithout(without: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mate-profile-'));
  dirs.push(root);
  writeProfileFiles(root, without);
  for (const dir of SKILL_DIRS) {
    mkdirSync(join(root, dir, 'deploy'), { recursive: true });
    writeFileSync(
      join(root, dir, 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy it.\n---\n\nSteps.\n',
    );
  }
  return root;
}

/** The path and each of its parents: `a/b/c`, `a/b`, `a`. */
function selfAndParents(path: string): string[] {
  const parts = path.split('/');
  return parts.map((_, i) => parts.slice(0, parts.length - i).join('/'));
}

/** `prompts` is operator's; `all` holds every profile's. */
async function load(
  root: string,
  log = new RecordingLog(),
  configured = CONFIGURED,
) {
  const all = await loadSystemPrompts(
    { root, ...OPTIONS, configured, log },
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

  test('has the persona the local pi package shares', async () => {
    expect(await repoText(PERSONA_FILE)).toStartWith('You are Rowbutt');
  });

  // The investigator reads only these sections of the owner's file.
  test("has the owner's instructions with the sections the investigator reads", async () => {
    const text = await repoText(OWNER_AGENTS_FILE);
    expect(text).toMatch(/^## Protect$/m);
    expect(text).toMatch(/^## Communicate$/m);
  });

  // turbo prune leaves these out, so each needs its own way into the image, a
  // rebuild when it changes, and a test run when it changes.
  test.each(PROFILE_INPUTS)(
    '%s reaches the image and the tests',
    async (file) => {
      const paths = selfAndParents(file);
      const dockerfile = (await repoText('apps/mate/Dockerfile')).split('\n');
      expect(
        dockerfile.some(
          (line) =>
            line.startsWith('COPY ') &&
            line.split(/\s+/).includes(`/app/${file}`),
        ),
      ).toBe(true);
      const ignore = (await repoText('.dockerignore')).split('\n');
      expect(paths.some((path) => ignore.includes(`!${path}`))).toBe(true);
      const [build] = JSON.parse(await repoText('apps/mate/build.json'));
      expect(paths.some((path) => build.watch.includes(path))).toBe(true);
      const turbo = JSON.parse(await repoText('turbo.json'));
      const inputs: string[] = turbo.tasks['mate#test'].inputs;
      expect(
        [file, ...paths.map((path) => `${path}/**`)].some((input) =>
          inputs.includes(`$TURBO_ROOT$/${input}`),
        ),
      ).toBe(true);
    },
  );

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
    expect(log.of('owner instructions section missing')).toEqual([]);
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
        'Nix builds run in CI, not here. Open a PR, which CI evaluates; a merge to `main` builds and pushes to Cachix',
        '`mise run format:check && mise run lint`, not `mise run check`',
        'The `kthx_*` tools, when listed, act on kthx built apps',
      ]) {
        expect(prompt).toContain(fact);
      }
    }
  });

  test('a missing root gives the fallback persona, the preamble and the overrides, and logs it', async () => {
    const root = join(tmpdir(), `mate-profile-missing-${Date.now()}`);
    const { all, log } = await load(root);
    for (const prompts of Object.values(all)) {
      for (const [, prompt] of each(prompts)) {
        expect(prompt.startsWith('You are Rowbutt')).toBe(true);
        expect(prompt.startsWith(`${FALLBACK_PERSONA}\n\n`)).toBe(true);
        expect(prompt).not.toContain('# Owner');
        expect(prompt).toContain(OVERRIDES_HEADING);
        expect(prompt).not.toContain('# Repository instructions');
        expect(prompt).not.toContain('<available_skills>');
      }
    }
    const missing = log.of('profile file missing').map((e) => e.fields?.path);
    expect(missing.sort()).toEqual(
      PROFILE_INPUTS.map((file) => `${root}/${file}`).sort(),
    );
  });

  test('a missing persona gives the fallback, and logs it', async () => {
    const root = rootWithout(PERSONA_FILE);
    const { all, log } = await load(root);
    for (const prompts of Object.values(all)) {
      for (const [, prompt] of each(prompts)) {
        expect(prompt.startsWith(`${FALLBACK_PERSONA}\n\n`)).toBe(true);
        expect(prompt).toContain(OWNER_HEADING);
        expect(prompt).toContain(`${REPO_HEADING}\n\nRules.`);
      }
    }
    expect(log.of('profile file missing').map((e) => e.fields?.path)).toEqual([
      `${root}/${PERSONA_FILE}`,
    ]);
  });

  test("a missing owner's file drops its section and keeps the overrides", async () => {
    const root = rootWithout(OWNER_AGENTS_FILE);
    const { all, log } = await load(root);
    for (const prompts of Object.values(all)) {
      for (const [, prompt] of each(prompts)) {
        expect(prompt.startsWith('You are Testbutt.\n\n')).toBe(true);
        expect(prompt).not.toContain('# Owner');
        expect(prompt).toContain(OVERRIDES_HEADING);
        expect(prompt).toContain(`${REPO_HEADING}\n\nRules.`);
      }
    }
    expect(log.of('profile file missing').map((e) => e.fields?.path)).toEqual([
      `${root}/${OWNER_AGENTS_FILE}`,
    ]);
  });

  test("an owner's file without a section the investigator reads is logged", async () => {
    const root = rootWithout(OWNER_AGENTS_FILE);
    mkdirSync(dirname(join(root, OWNER_AGENTS_FILE)), { recursive: true });
    writeFileSync(
      join(root, OWNER_AGENTS_FILE),
      '# Owner\n\n## Protect\n\n- Guard.\n\n## Delegate\n\n- Hand off.',
    );
    const { all, log } = await load(root);
    expect(all.investigator?.slack).toContain(
      `${OWNER_HEADING}\n\n# Owner\n\n## Protect\n\n- Guard.\n\n${OVERRIDES_HEADING}`,
    );
    expect(log.of('owner instructions section missing')).toEqual([
      {
        level: 'warn',
        msg: 'owner instructions section missing',
        fields: { profile: 'investigator', section: 'Communicate' },
      },
    ]);
  });

  test('a skills directory with no skills is logged, and the other still indexes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mate-profile-'));
    dirs.push(root);
    writeProfileFiles(root);
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
    writeProfileFiles(root);

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

  test('starts with the persona and its own preamble, and shares AGENTS.md and the skills', async () => {
    const persona = await repoText(PERSONA_FILE);
    const { all } = await load(REPO);
    const rest = (prompts: ProfilePrompts, id: string, preamble: string) => {
      const prompt = prompts[id]?.slack ?? '';
      expect(prompt.startsWith(`${persona}\n\n${preamble}\n\n`)).toBe(true);
      return prompt.slice(prompt.indexOf(REPO_HEADING));
    };
    const operator = rest(all, 'operator', operatorPreamble('Slack', OPTIONS));
    const investigator = rest(
      all,
      'investigator',
      investigatorPreamble('Slack', OPTIONS),
    );
    expect(investigator).toBe(operator);
    expect(investigator).toStartWith(REPO_HEADING);
    expect(investigator).toContain('<available_skills>');
    expect(all.custodian).toEqual(all.operator as SystemPrompts);
  });

  test('orders the persona, preamble, owner rules, overrides, AGENTS.md and skills', async () => {
    const persona = await repoText(PERSONA_FILE);
    const { all } = await load(REPO);
    for (const [id, preamble] of [
      ['operator', operatorPreamble],
      ['investigator', investigatorPreamble],
    ] as const) {
      const prompt = all[id]?.discord ?? '';
      const at = [
        persona,
        preamble('Discord', OPTIONS),
        OWNER_HEADING,
        OVERRIDES_HEADING,
        REPO_HEADING,
        '<available_skills>',
      ].map((part) => prompt.indexOf(part));
      expect(at[0]).toBe(0);
      for (let i = 1; i < at.length; i++) {
        expect(at[i]).toBeGreaterThan(at[i - 1] as number);
      }
    }
  });

  test("operator reads all of the owner's instructions", async () => {
    const owner = await repoText(OWNER_AGENTS_FILE);
    const { prompts } = await load(REPO);
    for (const [, prompt] of each(prompts)) {
      expect(prompt).toContain(`${OWNER_HEADING}\n\n${owner}\n\n`);
    }
  });

  test('claims only the access this deployment configures', async () => {
    const overrides = (prompt: string) =>
      prompt.slice(
        prompt.indexOf(OVERRIDES_HEADING),
        prompt.indexOf(REPO_HEADING),
      );
    const full = await load(REPO);
    for (const id of ['operator', 'custodian']) {
      const text = overrides(full.all[id]?.slack ?? '');
      for (const claim of [
        'merge pull requests',
        "An assignment's own merge rule replaces the limit to pull requests you opened.",
        '`atlantis apply`',
        'push to keep work',
        'cluster-admin',
        '`op` reaches 1Password',
      ]) {
        expect(text).toContain(claim);
      }
    }
    const bare = await load(REPO, new RecordingLog(), {
      github: false,
      vault: false,
      kube: { admin: false, reader: true },
    });
    for (const id of ['operator', 'custodian']) {
      for (const [, prompt] of each(bare.all[id] as SystemPrompts)) {
        const text = overrides(prompt);
        expect(text).toContain('never run `tofu apply`');
        for (const claim of [
          'merge pull requests',
          'merge rule',
          'atlantis apply',
          'push',
          'cluster-admin',
          '`op`',
        ]) {
          expect(text).not.toContain(claim);
        }
      }
    }
  });

  test("investigator reads only the owner's Protect and Communicate", async () => {
    const { all } = await load(REPO);
    for (const [, prompt] of each(all.investigator as SystemPrompts)) {
      const own = prompt.slice(0, prompt.indexOf(REPO_HEADING));
      expect(own).toContain('## Protect');
      expect(own).toContain('## Communicate');
      for (const absent of [
        '## Operate',
        '## Git and PRs',
        '## Validate',
        '## Delegate',
        'atlantis apply',
        'cluster-admin',
      ]) {
        expect(own).not.toContain(absent);
      }
      expect(own.toLowerCase()).not.toContain('merge');
    }
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
