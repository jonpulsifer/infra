import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatSkillsForSystemPrompt, loadSkills } from '../src/skills.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'mate-skills-'));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const skill = (name: string, description = 'Does it.', extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nSteps.\n`;

describe('loadSkills', () => {
  test('finds each SKILL.md, in name order, and stops below one', async () => {
    const root = tree({
      'b/SKILL.md': skill('b'),
      'a/SKILL.md': skill('a'),
      'a/inner/SKILL.md': skill('inner'),
      'group/c/SKILL.md': skill('c'),
      '.hidden/d/SKILL.md': skill('d'),
      'node_modules/e/SKILL.md': skill('e'),
      'README.md': '---\ndescription: Not a skill.\n---\n',
    });
    const { skills, diagnostics } = await loadSkills([root]);
    expect(skills.map((s) => [s.name, s.filePath])).toEqual([
      ['a', join(root, 'a/SKILL.md')],
      ['b', join(root, 'b/SKILL.md')],
      ['c', join(root, 'group/c/SKILL.md')],
    ]);
    expect(diagnostics).toEqual([]);
  });

  test('skips a missing directory without a word, and follows a symlinked skill', async () => {
    const root = tree({ 'real/SKILL.md': skill('linked') });
    symlinkSync(join(root, 'real'), join(root, 'linked'));
    const { skills, diagnostics } = await loadSkills([
      join(root, 'absent'),
      join(root, 'linked'),
    ]);
    expect(skills.map((s) => s.name)).toEqual(['linked']);
    expect(diagnostics).toEqual([]);
  });

  test('reads folded YAML descriptions and the disable flag', async () => {
    const root = tree({
      'deploy/SKILL.md':
        '---\nname: deploy\ndescription: >\n  Deploys: the app,\n  then checks it.\ndisable-model-invocation: true\n---\n',
    });
    const { skills } = await loadSkills([root]);
    expect(skills).toEqual([
      {
        name: 'deploy',
        description: 'Deploys: the app, then checks it.\n',
        filePath: join(root, 'deploy/SKILL.md'),
        disableModelInvocation: true,
      },
    ]);
  });

  test('warns about bad metadata, and drops a skill with no description', async () => {
    const root = tree({
      'mismatch/SKILL.md': skill('other'),
      'Bad_Name/SKILL.md': '---\ndescription: Fine.\n---\n',
      'quiet/SKILL.md': '---\nname: quiet\n---\n',
      'broken/SKILL.md': '---\nname: [oops\n---\n',
      'long/SKILL.md': skill('long', 'x'.repeat(1025)),
    });
    const { skills, diagnostics } = await loadSkills([root]);
    expect(skills.map((s) => s.name).sort()).toEqual([
      'Bad_Name',
      'long',
      'other',
    ]);
    const byPath = (name: string) =>
      diagnostics
        .filter((d) => d.path === join(root, name, 'SKILL.md'))
        .map((d) => [d.code, d.message]);
    expect(byPath('mismatch')).toEqual([
      [
        'invalid_metadata',
        'name "other" does not match parent directory "mismatch"',
      ],
    ]);
    expect(byPath('Bad_Name').map(([code]) => code)).toEqual([
      'invalid_metadata',
    ]);
    expect(byPath('quiet')).toEqual([
      ['invalid_metadata', 'description is required'],
    ]);
    expect(byPath('broken').map(([code]) => code)).toEqual(['parse_failed']);
    expect(byPath('long')).toEqual([
      ['invalid_metadata', 'description exceeds 1024 characters (1025)'],
    ]);
  });
});

describe('formatSkillsForSystemPrompt', () => {
  const listed = {
    name: 'deploy',
    description: 'Ship <it> & "go"',
    filePath: '/workspace/skills/deploy/SKILL.md',
    disableModelInvocation: false,
  };

  test('is empty without a visible skill', () => {
    expect(formatSkillsForSystemPrompt([])).toBe('');
    expect(
      formatSkillsForSystemPrompt([
        { ...listed, disableModelInvocation: true },
      ]),
    ).toBe('');
  });

  test('lists each visible skill, escaped', () => {
    const out = formatSkillsForSystemPrompt([
      listed,
      { ...listed, name: 'hidden', disableModelInvocation: true },
    ]);
    expect(out).toEndWith(
      [
        '<available_skills>',
        '  <skill>',
        '    <name>deploy</name>',
        '    <description>Ship &lt;it&gt; &amp; &quot;go&quot;</description>',
        '    <location>/workspace/skills/deploy/SKILL.md</location>',
        '  </skill>',
        '</available_skills>',
      ].join('\n'),
    );
    expect(out).not.toContain('hidden');
  });
});
