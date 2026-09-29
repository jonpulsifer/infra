import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { ConfigError } from '../src/config.ts';
import { createModelSetup, MODEL_KEY_ENV } from '../src/model.ts';
import { RecordingLog } from './support.ts';

const SPEC = 'opencode-go/qwen3.8-max';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function keyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mate-model-'));
  dirs.push(dir);
  return join(dir, 'api-key');
}

function setup(
  options: { spec?: string; thinking?: ThinkingLevel; keyFile?: string } = {},
) {
  const log = new RecordingLog();
  const made = createModelSetup({
    spec: options.spec ?? SPEC,
    thinking: options.thinking ?? 'medium',
    keyFile: options.keyFile ?? keyFile(),
    log,
  });
  return { ...made, log };
}

async function apiKey(made: ReturnType<typeof setup>) {
  return (await made.models.getAuth(made.model))?.auth.apiKey;
}

describe('createModelSetup', () => {
  test('resolves qwen3.8-max on the OpenCode Go endpoint', () => {
    const made = setup();
    expect(made.model.provider).toBe('opencode-go');
    expect(made.model.id).toBe('qwen3.8-max');
    expect(made.model.api).toBe('openai-completions');
    expect(made.model.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(made.thinking).toBe('medium');
  });

  test.each([
    'opencode-go/no-such-model',
    'anthropic/claude-opus-4-7',
    'qwen3.8-max',
    'opencode-go/',
  ])('refuses %s', (spec) => {
    expect(() => setup({ spec })).toThrow(ConfigError);
  });

  test.each<ThinkingLevel>(['off', 'high'])(
    'refuses thinking %s, naming the levels the model takes',
    (thinking) => {
      expect(() => setup({ thinking })).toThrow(
        new ConfigError(
          `MATE_THINKING=${thinking} is not a level ${SPEC} supports: low, medium, xhigh`,
        ),
      );
    },
  );

  test('reads the key file on every request, so a rotation needs no rebuild', async () => {
    const file = keyFile();
    writeFileSync(file, 'sk-first-key-0000\n');
    const made = setup({ keyFile: file });
    expect(await apiKey(made)).toBe('sk-first-key-0000');

    writeFileSync(file, 'sk-second-key-1111');
    expect(await apiKey(made)).toBe('sk-second-key-1111');
    expect(JSON.stringify(made.log.entries)).not.toContain('sk-');
  });

  test('a missing or empty key file gives no key, logged once per streak', async () => {
    const file = keyFile();
    const made = setup({ keyFile: file });
    expect(await apiKey(made)).toBeUndefined();
    expect(await apiKey(made)).toBeUndefined();
    expect(made.log.of('model key unreadable')).toHaveLength(1);

    writeFileSync(file, 'sk-key-2222');
    expect(await apiKey(made)).toBe('sk-key-2222');
    expect(made.log.of('model key readable again')).toHaveLength(1);

    writeFileSync(file, '  \n');
    expect(await apiKey(made)).toBeUndefined();
    unlinkSync(file);
    expect(await apiKey(made)).toBeUndefined();
    expect(made.log.of('model key unreadable')).toHaveLength(2);
  });

  test('never reads or sets the key in the process environment', async () => {
    const saved = process.env[MODEL_KEY_ENV];
    try {
      process.env[MODEL_KEY_ENV] = 'sk-from-the-environment';
      const missing = setup();
      expect(await apiKey(missing)).toBeUndefined();

      delete process.env[MODEL_KEY_ENV];
      const file = keyFile();
      writeFileSync(file, 'sk-from-the-file');
      const made = setup({ keyFile: file });
      expect(await apiKey(made)).toBe('sk-from-the-file');
      expect(process.env[MODEL_KEY_ENV]).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env[MODEL_KEY_ENV];
      else process.env[MODEL_KEY_ENV] = saved;
    }
  });
});
