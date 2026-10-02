import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelThinkingLevel as ThinkingLevel } from '@earendil-works/pi-ai';
import {
  type CredentialStore,
  InMemoryCredentialStore,
} from '@earendil-works/pi-ai';
import { ConfigError, readBrainConfig } from '../src/config.ts';
import {
  CHATGPT_PROVIDER,
  chatgptModel,
  createModelSetup,
  MODEL_KEY_ENV,
  profileModel,
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
    fallbackSpec?: string | null;
    fallbackThinking?: ThinkingLevel | null;
    keyFile?: string;
    credentials?: CredentialStore;
  } = {},
) {
  const log = new RecordingLog();
  const made = createModelSetup({
    spec: options.spec ?? SPEC,
    thinking: options.thinking ?? 'medium',
    fallbackSpec: options.fallbackSpec,
    fallbackThinking: options.fallbackThinking,
    keyFile: options.keyFile ?? keyFile(),
    credentials: options.credentials,
    log,
  });
  return { ...made, log };
}

const CODEX = 'openai-codex/gpt-6-sol';

async function apiKey(made: ReturnType<typeof setup>) {
  return (await made.models.getAuth(made.model))?.auth.apiKey;
}

describe('createModelSetup', () => {
  test('resolves qwen3.8-max on the OpenCode Go endpoint, with nothing routed', () => {
    const made = setup();
    expect(made.model.provider).toBe('opencode-go');
    expect(made.model.id).toBe('qwen3.8-max');
    expect(made.model.api).toBe('openai-completions');
    expect(made.model.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(made.thinking).toBe('medium');
    // `none` is the rollback: nothing routes, and a request drops another
    // model's reasoning, as the fallback's does.
    expect(made.router).toBeNull();
    expect(made.models).not.toBe(made.direct);
    expect(made.models.getModel(CHATGPT_PROVIDER, 'gpt-6-sol')?.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test('routes gpt-6-sol first and qwen3.8-max after, at their own levels', () => {
    const made = setup({ spec: CODEX, fallbackSpec: SPEC });
    expect(made.model.provider).toBe(CHATGPT_PROVIDER);
    expect(made.model.id).toBe('gpt-6-sol');
    expect(made.model.baseUrl).toBe('https://chatgpt.com/backend-api');
    expect(made.models).not.toBe(made.direct);
    const route = made.router?.status();
    expect(route?.fallback?.model.id).toBe('qwen3.8-max');
    expect(route?.fallback?.thinking).toBe('medium');
    expect(made.log.entries).toEqual([]);
  });

  test("ChatGPT's list price is zeroed, so the cost metric stays the fallback's shadow", () => {
    const made = setup({ spec: CODEX, fallbackSpec: SPEC });
    expect(made.model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(made.models.getModel(CHATGPT_PROVIDER, 'gpt-6-sol')?.cost).toEqual(
      made.model.cost,
    );
    expect(
      made.direct.getModel(CHATGPT_PROVIDER, 'gpt-6-sol')?.cost.output,
    ).toBe(10);
    expect(
      made.models.getModel('opencode-go', 'qwen3.8-max')?.cost.output,
    ).toBe(6);
  });

  test.each([
    'opencode-go/no-such-model',
    'openai-codex/no-such-model',
    'anthropic/claude-opus-4-7',
    'qwen3.8-max',
    'opencode-go/',
  ])('refuses %s', (spec) => {
    expect(() => setup({ spec })).toThrow(ConfigError);
  });

  test.each<[string, string | null, ThinkingLevel | null, string]>([
    [CODEX, CODEX, null, 'MATE_FALLBACK_MODEL must differ from MATE_MODEL'],
    [
      SPEC,
      'opencode-go/qwen3.8-flash',
      null,
      'MATE_FALLBACK_MODEL answers when ChatGPT cannot, so MATE_MODEL must be openai-codex/<model>',
    ],
    [CODEX, 'opencode-go/no-such-model', null, 'which pi-ai does not list'],
    [
      CODEX,
      SPEC,
      'high',
      `MATE_FALLBACK_THINKING=high is not a level ${SPEC} supports: low, medium, xhigh`,
    ],
  ])(
    'refuses %s falling back to %s at %p',
    (spec, fallbackSpec, fallbackThinking, why) => {
      expect(() => setup({ spec, fallbackSpec, fallbackThinking })).toThrow(
        why,
      );
    },
  );

  // Raising MATE_THINKING must never make mate refuse to boot over the fallback.
  test("an unset fallback level is the fallback's nearest to MATE_THINKING", () => {
    const made = setup({ spec: CODEX, thinking: 'high', fallbackSpec: SPEC });
    expect(made.thinking).toBe('high');
    expect(made.router?.status().fallback?.thinking).toBe('xhigh');
    const low = setup({
      spec: CODEX,
      thinking: 'high',
      fallbackSpec: SPEC,
      fallbackThinking: 'low',
    });
    expect(low.router?.status().fallback?.thinking).toBe('low');
  });

  test('a fallback with the smaller context window is warned of, since compaction follows the primary', () => {
    const made = setup({
      spec: CODEX,
      fallbackSpec: 'opencode-go/minimax-m2.7',
    });
    expect(
      made.log.of('the fallback model has the smaller context window'),
    ).toEqual([
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          primaryWindow: 272_000,
          fallbackWindow: 204_800,
        }),
      }),
    ]);
  });

  test("the Deployment's model settings build, so mate boots on them", async () => {
    const deployment = Bun.YAML.parse(
      await Bun.file(
        new URL(
          '../../../clusters/offsite/apps/mate/deployment.yaml',
          import.meta.url,
        ),
      ).text(),
    ) as {
      spec: {
        template: {
          spec: {
            containers: {
              name: string;
              env: { name: string; value?: string }[];
            }[];
          };
        };
      };
    };
    const mate = deployment.spec.template.spec.containers.find(
      (container) => container.name === 'mate',
    );
    const env = Object.fromEntries(
      (mate?.env ?? []).flatMap((one) =>
        one.name.startsWith('MATE_') && one.value !== undefined
          ? [[one.name, one.value]]
          : [],
      ),
    );
    const brain = readBrainConfig(env);
    const made = setup({
      spec: brain.model,
      thinking: brain.thinking,
      fallbackSpec: brain.fallbackModel,
      fallbackThinking: brain.fallbackThinking,
    });
    expect(made.log.entries).toEqual([]);
  });

  test('ChatGPT with no fallback still routes, to zero its price', () => {
    const made = setup({ spec: CODEX, fallbackSpec: null });
    expect(made.router?.status().fallback).toBeNull();
    expect(made.model.cost.input).toBe(0);
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

describe('profileModel', () => {
  test("MATE_MODEL's own spec is the lane's model, so the router still sees it", () => {
    const routed = setup({ spec: CODEX, fallbackSpec: SPEC });
    const own = profileModel(routed, 'profile p', CODEX, 'low');
    expect(own.model).toBe(routed.model);
    expect(own.model.cost.input).toBe(0);
    expect(own.thinking).toBe('low');
  });

  test('another catalog model goes straight to its provider', () => {
    const made = setup({ spec: CODEX, fallbackSpec: SPEC });
    const own = profileModel(
      made,
      'profile p',
      'opencode-go/minimax-m2.7',
      'medium',
    );
    expect(own.model).toBe(
      made.direct.getModel('opencode-go', 'minimax-m2.7') as typeof own.model,
    );
    expect(own.thinking).toBe('medium');
  });

  test('refuses a level the model does not support, and a model the catalog lacks', () => {
    const made = setup();
    expect(() => profileModel(made, 'profile p', SPEC, 'high')).toThrow(
      new ConfigError(
        `profile p=high is not a level ${SPEC} supports: low, medium, xhigh`,
      ),
    );
    expect(() =>
      profileModel(made, 'profile p', 'opencode-go/no-such-model', 'medium'),
    ).toThrow(ConfigError);
  });
});
