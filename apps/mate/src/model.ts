/**
 * The models mate's brain talks to, and what each pays with. The OpenCode Go
 * key is a mounted file read on every request, so a rotation needs no restart
 * and the key never enters `process.env`, stream options or a log. The
 * ChatGPT provider signs in through the credential store instead. With a
 * fallback, requests for a ChatGPT primary go through the router.
 */
import type { ModelThinkingLevel as ThinkingLevel } from '@earendil-works/pi-ai';
import {
  type Api,
  clampThinkingLevel,
  createModels,
  getSupportedThinkingLevels,
  type Model,
  type Models,
  type Provider,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import type { ModelSetup, ModelSetupOptions } from './brain-inputs.ts';
import { systemClock } from './clock.ts';
import { ConfigError } from './config.ts';
import { type Log, plain } from './log.ts';
import {
  CHATGPT_PROVIDER,
  routeModels,
  spec,
  unpriced,
  unroutedModels,
} from './route.ts';

export { CHATGPT_PROVIDER } from './route.ts';

/** The only variable pi-ai's OpenCode Go provider reads its key from. */
export const MODEL_KEY_ENV = 'OPENCODE_API_KEY';
/** The ChatGPT model a sign-in's test request goes to while turns use another. */
export const CHATGPT_MODEL = 'gpt-6-sol';

/** What production registers: the fallback's provider, then ChatGPT's. */
export function defaultProviders(): Provider[] {
  return [opencodeGoProvider(), openaiCodexProvider()];
}

function lookup(models: Models, name: string, wanted: string): Model<Api> {
  const slash = wanted.indexOf('/');
  const provider = slash > 0 ? wanted.slice(0, slash) : '';
  const id = slash > 0 ? wanted.slice(slash + 1) : '';
  const registered = models.getProviders().map((one) => one.id);
  if (!registered.includes(provider) || !id) {
    throw new ConfigError(
      `${name} must be ${registered.join('/<model> or ')}/<model>, got ${wanted}`,
    );
  }
  const model = models.getModel(provider, id);
  if (!model) {
    throw new ConfigError(`${name} names ${wanted}, which pi-ai does not list`);
  }
  return model;
}

// The catalog maps an unsupported level to null, and a null level sends no
// reasoning parameter, so the model would think at its own default.
function supported(name: string, model: Model<Api>, level: ThinkingLevel) {
  const levels = getSupportedThinkingLevels(model);
  if (!levels.includes(level)) {
    throw new ConfigError(
      `${name}=${level} is not a level ${spec(model)} supports: ${levels.join(', ')}`,
    );
  }
}

/**
 * Throws `ConfigError` for a provider not in `providers`, a model the
 * catalog lacks, a thinking level outside pi-ai's
 * `getSupportedThinkingLevels(model)`, or a fallback that is the primary or
 * backs a primary other than ChatGPT.
 */
export function createModelSetup({
  spec: wanted,
  thinking,
  fallbackSpec = null,
  fallbackThinking = null,
  keyFile,
  credentials,
  providers = defaultProviders(),
  log,
  clock = systemClock,
  metrics,
}: ModelSetupOptions): ModelSetup {
  const readKey = keyReader(keyFile, log);
  const direct = createModels({
    credentials,
    authContext: {
      env: (name) =>
        name === MODEL_KEY_ENV ? readKey() : Promise.resolve(undefined),
      fileExists: () => Promise.resolve(false),
    },
  });
  for (const provider of providers) direct.setProvider(provider);
  const model = lookup(direct, 'MATE_MODEL', wanted);
  supported('MATE_THINKING', model, thinking);
  const chatgpt = model.provider === CHATGPT_PROVIDER;
  if (fallbackSpec === null && !chatgpt) {
    return {
      models: unroutedModels(direct),
      direct,
      model,
      thinking,
      router: null,
    };
  }
  let fallback: { model: Model<Api>; thinking: ThinkingLevel } | null = null;
  if (fallbackSpec !== null) {
    if (!chatgpt) {
      throw new ConfigError(
        `MATE_FALLBACK_MODEL answers when ChatGPT cannot, so MATE_MODEL must be ${CHATGPT_PROVIDER}/<model>, got ${wanted}; set MATE_FALLBACK_MODEL=none`,
      );
    }
    const backup = lookup(direct, 'MATE_FALLBACK_MODEL', fallbackSpec);
    if (backup.provider === model.provider && backup.id === model.id) {
      throw new ConfigError(
        `MATE_FALLBACK_MODEL must differ from MATE_MODEL, both ${wanted}; set it to none for no fallback`,
      );
    }
    const level = fallbackThinking ?? clampThinkingLevel(backup, thinking);
    supported('MATE_FALLBACK_THINKING', backup, level);
    // Compaction follows the lane's window, so a smaller fallback could overflow.
    if (backup.contextWindow < model.contextWindow) {
      log.warn('the fallback model has the smaller context window', {
        primary: spec(model),
        primaryWindow: model.contextWindow,
        fallback: spec(backup),
        fallbackWindow: backup.contextWindow,
      });
    }
    fallback = { model: backup, thinking: level };
  }
  const { models, router } = routeModels(direct, {
    primary: model,
    fallback,
    clock,
    log,
    metrics,
  });
  return { models, direct, model: unpriced(model), thinking, router };
}

/**
 * A profile's own model. MATE_MODEL's own spec returns `setup.model`, so the
 * router still sees it; any other model goes straight to its provider.
 */
export function profileModel(
  setup: ModelSetup,
  name: string,
  wanted: string,
  thinking: ThinkingLevel,
): { model: Model<Api>; thinking: ThinkingLevel } {
  const model =
    wanted === spec(setup.model)
      ? setup.model
      : lookup(setup.direct, name, wanted);
  supported(name, model, thinking);
  return { model, thinking };
}

/** The model a ChatGPT sign-in proves: the lane's own, or pi's `gpt-6-sol`. */
export function chatgptModel(setup: ModelSetup): Model<Api> | null {
  if (setup.model.provider === CHATGPT_PROVIDER) return setup.model;
  return setup.direct.getModel(CHATGPT_PROVIDER, CHATGPT_MODEL) ?? null;
}

function keyReader(file: string, log: Log): () => Promise<string | undefined> {
  let failing = false;
  return async () => {
    let key: string | undefined;
    let problem = 'the file is empty';
    try {
      key = (await Bun.file(file).text()).trim() || undefined;
    } catch (error) {
      problem = plain(error);
    }
    if (key) {
      if (failing) log.info('model key readable again', { file });
      failing = false;
      return key;
    }
    if (!failing) log.warn('model key unreadable', { file, error: problem });
    failing = true;
    return undefined;
  };
}
