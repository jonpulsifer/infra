import { type Config, ConfigError } from './config.ts';
import type { Log } from './log.ts';

const AGENTS_URL = 'https://api.elevenlabs.io/v1/convai/agents';
const PAGE_SIZE = 100;
// Far past the account's size; the bound stops a cursor that never advances
// from paging forever.
const MAX_PAGES = 20;
const TIMEOUT_MS = 10_000;

export type AgentLookupFailure =
  | 'timeout'
  | 'network'
  | 'http-error'
  | 'bad-response'
  | 'not-found'
  | 'ambiguous';

export class AgentLookupError extends Error {
  readonly reason: AgentLookupFailure;
  readonly httpStatus?: number;

  constructor(reason: AgentLookupFailure, httpStatus?: number) {
    super(`elevenlabs agent lookup failed: ${reason}`);
    this.name = 'AgentLookupError';
    this.reason = reason;
    this.httpStatus = httpStatus;
  }

  /**
   * True when a later attempt could answer differently. A 401, 403 or 404
   * is the account's answer, not the network's, so it is final.
   */
  get transient(): boolean {
    if (this.reason === 'timeout' || this.reason === 'network') return true;
    if (this.reason !== 'http-error') return false;
    const status = this.httpStatus ?? 0;
    return status === 408 || status === 429 || status >= 500;
  }
}

interface AgentsPage {
  agents?: { agent_id?: string; name?: string }[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function fetchPage(apiKey: string, cursor?: string): Promise<AgentsPage> {
  const url = new URL(AGENTS_URL);
  url.searchParams.set('page_size', String(PAGE_SIZE));
  if (cursor) url.searchParams.set('cursor', cursor);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    throw new AgentLookupError(timedOut ? 'timeout' : 'network');
  }
  if (!res.ok) throw new AgentLookupError('http-error', res.status);
  const body = (await res.json().catch(() => null)) as AgentsPage | null;
  if (!body || !Array.isArray(body.agents)) {
    throw new AgentLookupError('bad-response');
  }
  return body;
}

export interface FindAgentOptions {
  readonly apiKey: string;
  readonly name: string;
}

/**
 * The id of the one agent whose name is `name`. The list's `search` is fuzzy,
 * so every page is read and the name compared here; no match, or more than
 * one, is a failure, not a guess. The thrown error never carries the URL or
 * the key.
 */
export async function findAgentId(opts: FindAgentOptions): Promise<string> {
  const matches: string[] = [];
  let cursor: string | undefined;
  let more = true;
  for (let page = 0; page < MAX_PAGES && more; page++) {
    const body = await fetchPage(opts.apiKey, cursor);
    for (const agent of body.agents ?? []) {
      if (agent.name === opts.name && typeof agent.agent_id === 'string') {
        matches.push(agent.agent_id);
      }
    }
    more = body.has_more === true && typeof body.next_cursor === 'string';
    cursor = body.next_cursor ?? undefined;
  }
  // The bound cut the listing short, so a match could still be a duplicate.
  if (more) throw new AgentLookupError('bad-response');
  if (matches.length === 0) throw new AgentLookupError('not-found');
  if (matches.length > 1) throw new AgentLookupError('ambiguous');
  return matches[0] as string;
}

export interface ResolveAgentOptions {
  readonly log: Log;
  readonly attempts?: number;
  readonly delayMs?: number;
  /** Overridable for tests; defaults to a real wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The agent id switchboard dials with, settled once at boot: the override
 * from `SWITCHBOARD_AGENT_ID` when set, else the agent named
 * `SWITCHBOARD_AGENT_NAME`. A transport failure is retried a bounded number
 * of times; a definitive answer (no such agent, or two of them) is a config
 * error at once.
 */
export async function resolveAgentId(
  config: Pick<Config, 'elevenlabsApiKey' | 'agentId' | 'agentName'>,
  opts: ResolveAgentOptions,
): Promise<string> {
  if (config.agentId) return config.agentId;
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 3_000;
  const sleep = opts.sleep ?? wait;
  const name = config.agentName;
  for (let attempt = 1; ; attempt++) {
    try {
      const agentId = await findAgentId({
        apiKey: config.elevenlabsApiKey,
        name,
      });
      opts.log.info('agent resolved', { name, agentId });
      return agentId;
    } catch (error) {
      if (!(error instanceof AgentLookupError)) throw error;
      if (!error.transient || attempt >= attempts) {
        throw new ConfigError(
          `SWITCHBOARD_AGENT_NAME could not be resolved: ${error.reason}`,
        );
      }
      opts.log.warn('agent lookup failed', {
        name,
        reason: error.reason,
        status: error.httpStatus,
        attempt,
      });
      await sleep(delayMs);
    }
  }
}
