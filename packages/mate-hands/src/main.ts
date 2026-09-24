/**
 * mate-hands, the tool daemon in a mate sandbox. mate starts one per exec
 * stream, each with a newer epoch, and speaks `protocol.ts` over its stdin
 * and stdout. Logs are JSON lines on stderr.
 */
import { constants, homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Daemon, type Fields, type Log, limitsFor } from './daemon.ts';
import { HANDS_VERSION } from './protocol.ts';

const USAGE =
  'usage: mate-hands --epoch N [--cwd DIR] [--state-dir DIR] [--watchdog-ms MS] [--max-read-bytes N] [--shell PATH]';
const DEFAULT_WATCHDOG_MS = 60_000;
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;

function line(level: string, msg: string, fields?: Fields): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...fields };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

const log: Log = {
  info: (msg, fields) => line('info', msg, fields),
  warn: (msg, fields) => line('warn', msg, fields),
};

function usage(problem: string): never {
  process.stderr.write(`mate-hands: ${problem}\n${USAGE}\n`);
  process.exit(64);
}

function args() {
  try {
    return parseArgs({
      options: {
        epoch: { type: 'string' },
        cwd: { type: 'string' },
        'state-dir': { type: 'string' },
        'watchdog-ms': { type: 'string' },
        'max-read-bytes': { type: 'string' },
        shell: { type: 'string' },
        version: { type: 'boolean' },
      },
    }).values;
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
}

function positive(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    usage(`--${name} must be a positive integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const values = args();
  if (values.version) {
    process.stdout.write(`mate-hands ${HANDS_VERSION}\n`);
    return;
  }
  const epoch = positive(values.epoch, 'epoch');
  if (epoch === undefined) usage('--epoch is required');
  const home = homedir();
  const stateHome = process.env.XDG_STATE_HOME || join(home, '.local', 'state');
  const daemon = new Daemon(
    {
      epoch,
      cwd: resolve(values.cwd ?? process.cwd()),
      home,
      tmp: tmpdir(),
      shell: values.shell ?? '/bin/bash',
      stateDir: resolve(values['state-dir'] ?? join(stateHome, 'mate-hands')),
      watchdogMs:
        positive(values['watchdog-ms'], 'watchdog-ms') ?? DEFAULT_WATCHDOG_MS,
      limits: limitsFor(
        positive(values['max-read-bytes'], 'max-read-bytes') ??
          DEFAULT_MAX_READ_BYTES,
      ),
      log,
    },
    {
      stdin: process.stdin,
      stdout: process.stdout,
      exit: (code) => process.exit(code),
    },
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void daemon.stop(signal, 128 + constants.signals[signal]);
    });
  }
  await daemon.start();
}

try {
  await main();
} catch (error) {
  line('error', 'mate-hands failed to start', { error: String(error) });
  process.exit(1);
}
