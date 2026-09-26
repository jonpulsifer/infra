import { startBoard } from './board/main.ts';
import { ConfigError } from './config.ts';
import { jsonLog as log } from './log.ts';
import { startRing } from './ring.ts';
import { readRole } from './role.ts';

const EXIT_CONFIG = 64;

function exitOnConfigError(error: unknown): never {
  if (error instanceof ConfigError) {
    log.error('config error', { error: error.message });
    process.exit(EXIT_CONFIG);
  }
  throw error;
}

// The role is read first, so the board never asks for the ringer's
// ElevenLabs key and tokens, and the ringer never asks for the board's ARI
// credentials.
let role: ReturnType<typeof readRole>;
try {
  role = readRole(process.env);
} catch (error) {
  exitOnConfigError(error);
}

const start = role === 'board' ? startBoard : startRing;
await start(process.env, log).catch(exitOnConfigError);
