import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../src/config.ts';
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

  test('a malformed number is a config error that never echoes it', () => {
    writeFileSync(join(dir, 'sam'), '555-0123');
    try {
      readTargets(dir);
      throw new Error('expected readTargets to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('sam');
      expect((error as Error).message).not.toContain('555-0123');
    }
  });

  test('an empty or missing directory is an empty list', () => {
    expect(readTargets(dir).size).toBe(0);
    expect(readTargets(join(dir, 'nope')).size).toBe(0);
  });
});
