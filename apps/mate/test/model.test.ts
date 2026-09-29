import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type CredentialStore,
  InMemoryCredentialStore,
} from '@earendil-works/pi-ai';
import { ConfigError } from '../src/config.ts';
import {
  CHATGPT_PROVIDER,
  chatgptModel,
  createModelSetup,
  MODEL_KEY_ENV,
} from '../src/model.ts';
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
  options: {
    spec?: string;
    thinking?: ThinkingLevel;
    keyFile?: string;
    credentials?: CredentialStore;
  } = {},
) {
  const log = new RecordingLog();
  const made = createModelSetup({
    spec: options.spec ?? SPEC,
    thinking: options.thinking ?? 'medium',
    keyFile: options.keyFile ?? keyFile(),
    credentials: options.credentials,
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

  // Turns stay on OpenCode Go until the router that falls back from ChatGPT exists.
  test.each([
    'opencode-go/no-such-model',
    'openai-codex/gpt-6-sol',
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

  test('signs ChatGPT in through the credential store, which the key file never reaches', async () => {
    const credentials = new InMemoryCredentialStore();
    const file = keyFile();
    writeFileSync(file, 'sk-opencode-key');
    const made = setup({ keyFile: file, credentials });
    const chatgpt = chatgptModel(made);
    expect(chatgpt?.provider).toBe(CHATGPT_PROVIDER);
    expect(chatgpt?.id).toBe('gpt-6-sol');
    expect(chatgpt?.baseUrl).toBe('https://chatgpt.com/backend-api');
    expect(await made.models.getAuth(CHATGPT_PROVIDER)).toBeUndefined();

    await credentials.modify(CHATGPT_PROVIDER, async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 86_400_000,
    }));
    expect((await made.models.getAuth(CHATGPT_PROVIDER))?.auth.apiKey).toBe(
      'access-token',
    );
    expect(await apiKey(made)).toBe('sk-opencode-key');
  });

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
