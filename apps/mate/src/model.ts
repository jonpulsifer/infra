/**
 * The model mate's brain talks to, and the key it pays with. The key is a
 * mounted file read on every request, so a rotation needs no restart and the
 * key never enters `process.env`, stream options or a log. The ChatGPT
 * provider signs in through the credential store instead.
 */
import {
  type Api,
  createModels,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import type { CreateModelSetup, ModelSetup } from './brain-inputs.ts';
import { ConfigError } from './config.ts';
import { type Log, plain } from './log.ts';

const MODEL_PROVIDER = 'opencode-go';
/** The only variable pi-ai's OpenCode Go provider reads its key from. */
export const MODEL_KEY_ENV = 'OPENCODE_API_KEY';
export const CHATGPT_PROVIDER = 'openai-codex';
/** The ChatGPT model a sign-in's test request goes to while turns use another. */
export const CHATGPT_MODEL = 'gpt-6-sol';

export const createModelSetup: CreateModelSetup = ({
  spec,
  thinking,
  keyFile,
  credentials,
  log,
}) => {
  const slash = spec.indexOf('/');
  const provider = slash > 0 ? spec.slice(0, slash) : '';
  const id = slash > 0 ? spec.slice(slash + 1) : '';
  if (provider !== MODEL_PROVIDER || !id) {
    throw new ConfigError(
      `MATE_MODEL must be ${MODEL_PROVIDER}/<model>, got ${spec}`,
    );
  }
  const readKey = keyReader(keyFile, log);
  const models = createModels({
    credentials,
    authContext: {
      env: (name) =>
        name === MODEL_KEY_ENV ? readKey() : Promise.resolve(undefined),
      fileExists: () => Promise.resolve(false),
    },
  });
  models.setProvider(opencodeGoProvider());
  models.setProvider(openaiCodexProvider());
  const model = models.getModel(provider, id);
  if (!model) {
    throw new ConfigError(
      `MATE_MODEL names ${spec}, which pi-ai does not list`,
    );
  }
  // The catalog maps an unsupported level to null, and a null level sends no
  // reasoning parameter, so the model would think at its own default.
  const supported = getSupportedThinkingLevels(model);
  if (!supported.includes(thinking)) {
    throw new ConfigError(
      `MATE_THINKING=${thinking} is not a level ${spec} supports: ${supported.join(', ')}`,
    );
  }
  return { models, model, thinking };
};

/** The model a ChatGPT sign-in proves: the lane's own, or pi's `gpt-6-sol`. */
export function chatgptModel(setup: ModelSetup): Model<Api> | null {
  if (setup.model.provider === CHATGPT_PROVIDER) return setup.model;
  return setup.models.getModel(CHATGPT_PROVIDER, CHATGPT_MODEL) ?? null;
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
