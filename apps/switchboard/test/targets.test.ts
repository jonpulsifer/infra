import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fields, Log } from '../src/log.ts';
import { readTargets } from '../src/targets.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'targets-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readTargets', () => {
  test('reads one number per file, trimmed, keyed by file name', () => {
    writeFileSync(join(dir, 'sam'), '+15555550123\n');
    writeFileSync(join(dir, 'alex'), ' +15555550124 ');
    expect([...readTargets(dir)]).toEqual([
      ['alex', '+15555550124'],
      ['sam', '+15555550123'],
    ]);
  });

  test('skips the token and every dot entry', () => {
    writeFileSync(join(dir, 'sam'), '+15555550123');
    writeFileSync(join(dir, 'token'), 'not-a-number');
    writeFileSync(join(dir, '..data'), 'not-a-number');
    mkdirSync(join(dir, '..2026_01_01'));
    expect([...readTargets(dir).keys()]).toEqual(['sam']);
  });

  test('a file without an E.164 number is skipped with a warning naming only the key', () => {
    writeFileSync(join(dir, 'sam'), '555-0123');
    writeFileSync(join(dir, 'notesPlain'), '');
    writeFileSync(join(dir, 'alex'), '+15555550124');
    const lines: string[] = [];
    const capture = (msg: string, fields?: Fields) =>
      lines.push(JSON.stringify({ msg, ...fields }));
    const log: Log = { info: capture, warn: capture, error: capture };
    expect([...readTargets(dir, log)]).toEqual([['alex', '+15555550124']]);
    expect(lines).toEqual([
      JSON.stringify({ msg: 'mission target skipped', target: 'notesPlain' }),
      JSON.stringify({ msg: 'mission target skipped', target: 'sam' }),
    ]);
    expect(lines.join('\n')).not.toContain('555-0123');
  });

  test('an empty or missing directory is an empty list', () => {
    expect(readTargets(dir).size).toBe(0);
    expect(readTargets(join(dir, 'nope')).size).toBe(0);
  });
});
