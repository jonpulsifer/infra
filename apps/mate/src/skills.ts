/**
 * Agent skills: a directory per skill holding a `SKILL.md` whose frontmatter
 * names and describes it, and the index of them the system prompt carries.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly disableModelInvocation: boolean;
}

export type SkillDiagnosticCode =
  | 'file_info_failed'
  | 'list_failed'
  | 'read_failed'
  | 'parse_failed'
  | 'invalid_metadata';

export interface SkillDiagnostic {
  readonly code: SkillDiagnosticCode;
  readonly message: string;
  readonly path: string;
}

/**
 * Finds each `SKILL.md` under `dirs`, following symlinks. A directory with one
 * holds a skill and nothing below it; dot directories and `node_modules` are
 * skipped, and a directory that does not exist is skipped without a word.
 */
export async function loadSkills(
  dirs: readonly string[],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const dir of dirs) await walk(dir, skills, diagnostics);
  return { skills, diagnostics };
}

async function walk(
  dir: string,
  skills: Skill[],
  diagnostics: SkillDiagnostic[],
): Promise<void> {
  const warn = (code: SkillDiagnosticCode, error: unknown, path = dir) =>
    diagnostics.push({ code, message: messageOf(error), path });
  try {
    if (!(await stat(dir)).isDirectory()) return;
  } catch (error) {
    if (!isMissing(error)) warn('file_info_failed', error);
    return;
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    warn('list_failed', error);
    return;
  }
  const file = join(dir, 'SKILL.md');
  if (
    names.includes('SKILL.md') &&
    (await stat(file).catch(() => null))?.isFile()
  ) {
    await loadSkill(file, basename(dir), skills, diagnostics);
    return;
  }
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    await walk(join(dir, name), skills, diagnostics);
  }
}

async function loadSkill(
  filePath: string,
  parentDir: string,
  skills: Skill[],
  diagnostics: SkillDiagnostic[],
): Promise<void> {
  const warn = (code: SkillDiagnosticCode, error: unknown) =>
    diagnostics.push({ code, message: messageOf(error), path: filePath });
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(await readFile(filePath, 'utf8'));
  } catch (error) {
    warn(error instanceof ParseError ? 'parse_failed' : 'read_failed', error);
    return;
  }
  const description =
    typeof frontmatter.description === 'string'
      ? frontmatter.description
      : undefined;
  for (const problem of descriptionProblems(description)) {
    warn('invalid_metadata', problem);
  }
  const frontmatterName =
    typeof frontmatter.name === 'string' ? frontmatter.name : undefined;
  const name = frontmatterName || parentDir;
  for (const problem of nameProblems(name, parentDir)) {
    warn('invalid_metadata', problem);
  }
  if (!description || description.trim() === '') return;
  skills.push({
    name,
    description,
    filePath,
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
  });
}

class ParseError extends Error {}

function parseFrontmatter(content: string): Record<string, unknown> {
  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  try {
    return (Bun.YAML.parse(text.slice(4, end)) ?? {}) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new ParseError(messageOf(error));
  }
}

function nameProblems(name: string, parentDir: string): string[] {
  const problems: string[] = [];
  if (name !== parentDir) {
    problems.push(
      `name "${name}" does not match parent directory "${parentDir}"`,
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    problems.push(
      `name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    problems.push(
      'name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)',
    );
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    problems.push('name must not start or end with a hyphen');
  }
  if (name.includes('--')) {
    problems.push('name must not contain consecutive hyphens');
  }
  return problems;
}

function descriptionProblems(description: string | undefined): string[] {
  if (!description || description.trim() === '') {
    return ['description is required'];
  }
  return description.length > MAX_DESCRIPTION_LENGTH
    ? [
        `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
      ]
    : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The skills the model may pick from, as the system prompt lists them; empty when none. */
export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return '';
  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    'Read the full skill file when the task matches its description.',
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];
  for (const skill of visible) {
    lines.push(
      '  <skill>',
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      '  </skill>',
    );
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
