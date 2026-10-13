/**
 * `bun run evals` prints the ledger of mate's recorded steps by model, and
 * with `--model` replays the recorded tool decisions against each candidate.
 * It reads the session store at MATE_EVALS_DATABASE_URL in a read-only
 * session and nothing else of mate's: no thread is touched and the ChatGPT
 * sign-in in mate-db is never read. A candidate on OpenCode Go takes
 * OPENCODE_API_KEY; any other provider takes a pi-ai credential from the JSON
 * file MATE_EVALS_CREDENTIALS_FILE, keyed by provider id, which the replay
 * refreshes in place.
 */
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  type Api,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  createModels,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel as ThinkingLevel,
} from '@earendil-works/pi-ai';
import { SQL } from 'bun';
import {
  DEFAULT_DECISIONS,
  DEFAULT_THREADS,
  ledger,
  median,
  readThreads,
  renderDisagreements,
  renderLedger,
  renderSummaries,
  replay,
  type Summary,
  sample,
  summarize,
} from './evals.ts';
import { defaultProviders } from './model.ts';

const DURATION = /^(\d+)([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export function instant(text: string, now: number): number {
  if (text === 'now') return now;
  const match = DURATION.exec(text);
  if (match) {
    return now - Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`${text} is not a duration like 7d or an ISO 8601 instant`);
  }
  return parsed;
}

/** A flag that must be a whole number of at least 1. */
export function count(flag: string, text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `--${flag} must be a whole number of at least 1, got ${text}`,
    );
  }
  return value;
}

/**
 * pi-ai credentials in one JSON file keyed by provider id. Every write is
 * serialized, lands through a rename so a crash never truncates a rotated
 * refresh token, and leaves the file at mode 0600.
 */
export class FileCredentialStore implements CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, Credential>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<
        string,
        Credential
      >;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async save(all: Record<string, Credential>): Promise<void> {
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }

  /** Runs `fn` after every earlier write, so no two writes interleave. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.load())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.load()).map(
      ([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.serialized(async () => {
      const all = await this.load();
      const next = await fn(all[providerId]);
      if (next === undefined) return all[providerId];
      all[providerId] = next;
      await this.save(all);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serialized(async () => {
      const all = await this.load();
      if (!(providerId in all)) return;
      delete all[providerId];
      await this.save(all);
    });
  }
}

function usage(): never {
  console.error(`usage: bun run evals -- [--since 7d] [--until now] [--threads ${DEFAULT_THREADS}] [--profile <id>]
                          [--model <provider/model>[,<provider/model>]]... [--decisions ${DEFAULT_DECISIONS}]
                          [--thinking off|minimal|low|medium|high|xhigh|max] [--json]

  MATE_EVALS_DATABASE_URL        the session store to read (required)
  OPENCODE_API_KEY               the key of an opencode-go candidate
  MATE_EVALS_CREDENTIALS_FILE    pi-ai credentials by provider id, for any other candidate`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      since: { type: 'string', default: '7d' },
      until: { type: 'string', default: 'now' },
      threads: { type: 'string', default: String(DEFAULT_THREADS) },
      profile: { type: 'string' },
      model: { type: 'string', multiple: true, default: [] },
      decisions: { type: 'string', default: String(DEFAULT_DECISIONS) },
      thinking: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) usage();
  const url = Bun.env.MATE_EVALS_DATABASE_URL?.trim();
  if (!url) {
    console.error('MATE_EVALS_DATABASE_URL is not set');
    usage();
  }
  const now = Date.now();
  const since = instant(values.since, now);
  const until = instant(values.until, now);
  if (until <= since) throw new Error('--until must be after --since');
  const threadLimit = count('threads', values.threads);
  const decisionLimit = count('decisions', values.decisions);
  if (
    values.thinking !== undefined &&
    !THINKING_LEVELS.includes(values.thinking as ThinkingLevel)
  ) {
    throw new Error(
      `--thinking must be one of ${THINKING_LEVELS.join(', ')}, got ${values.thinking}`,
    );
  }
  const thinking = values.thinking as ThinkingLevel | undefined;
  // One connection, read-only for its life: the evals never write mate-db.
  const sql = new SQL(url, { max: 1 });
  try {
    await sql`SET default_transaction_read_only = on`;
    const threads = await readThreads(sql, {
      since,
      until,
      limit: threadLimit,
      ...(values.profile ? { profile: values.profile } : {}),
    });
    const rows = ledger(threads);
    const candidates = values.model.flatMap((one) => one.split(','));
    const summaries: Summary[] = [];
    const disagreements: string[] = [];
    if (candidates.length > 0) {
      const credentialsFile = Bun.env.MATE_EVALS_CREDENTIALS_FILE?.trim();
      const models = createModels(
        credentialsFile
          ? { credentials: new FileCredentialStore(credentialsFile) }
          : {},
      );
      for (const provider of defaultProviders()) models.setProvider(provider);
      const picked = sample(threads, decisionLimit);
      for (const spec of candidates) {
        const slash = spec.indexOf('/');
        const model: Model<Api> | undefined =
          slash > 0
            ? models.getModel(spec.slice(0, slash), spec.slice(slash + 1))
            : undefined;
        if (!model) throw new Error(`${spec} is not a model pi-ai lists`);
        if (
          thinking &&
          thinking !== 'off' &&
          !getSupportedThinkingLevels(model).includes(thinking)
        ) {
          throw new Error(
            `${spec} does not support thinking ${thinking}; it supports ${getSupportedThinkingLevels(model).join(', ')}`,
          );
        }
        if ((await models.checkAuth(model.provider)) === undefined) {
          throw new Error(
            `${spec} has no credentials: set OPENCODE_API_KEY for opencode-go, or MATE_EVALS_CREDENTIALS_FILE with a ${model.provider} entry`,
          );
        }
        const verdicts = await replay(models, model, picked, {
          ...(thinking ? { thinking } : {}),
          onVerdict: (_verdict, done, total) => {
            if (!values.json)
              process.stderr.write(`\r${spec}: ${done}/${total}`);
          },
        });
        if (!values.json) process.stderr.write('\n');
        summaries.push(summarize(spec, verdicts));
        disagreements.push(`## ${spec}\n\n${renderDisagreements(verdicts)}`);
      }
    }
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            window: {
              since: new Date(since).toISOString(),
              until: new Date(until).toISOString(),
            },
            threads: threads.length,
            ledger: rows.map(({ latencies, ...row }) => ({
              ...row,
              medianMs: median(latencies),
            })),
            replay: summaries,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(
      `${threads.length} threads from ${new Date(since).toISOString()} to ${new Date(until).toISOString()}\n`,
    );
    console.log(renderLedger(rows));
    if (summaries.length > 0) {
      console.log(`\n${renderSummaries(summaries)}\n`);
      console.log(disagreements.join('\n\n'));
    }
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
