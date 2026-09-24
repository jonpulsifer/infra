/**
 * Deploys a function to Cloudflare Workers on a custom domain, not a route: the
 * platform then owns the hostname's record and certificate, so nothing here
 * writes DNS.
 *
 * ponytail: no per-function compatibility flags; add them to the metadata part
 * when a function needs one.
 */
import { CLOUDFLARE_API_ROOT } from '../adapters/cloudflare.ts';
import type { Fetcher, TokenProvider } from '../adapters/deploy/cloud/http.ts';
import { servableZone } from '../domain/vessel.ts';
import {
  FunctionDeployError,
  type FunctionDeployer,
  type FunctionEnv,
  type FunctionLogEntry,
  type FunctionTarget,
  workloadName,
} from './contract.ts';

/**
 * Pinned: a date that moved with the clock would change a deployed function's
 * behaviour on a redeploy nobody asked for.
 */
const COMPATIBILITY_DATE = '2026-08-01';

/** The label between the function's name and the zone: `<name>.fn.<zone>`. */
const DEFAULT_SUBDOMAIN = 'fn';

const TAIL_PROTOCOL = 'trace-v1';

/**
 * Doubles while the far side keeps closing and resets once a line arrives, so
 * a session that dies on arrival is not re-minted in a hot loop.
 */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface WorkersFunctionsOptions {
  readonly token: TokenProvider;
  readonly accountId: string;
  /**
   * In declaration order. `dns.zones` names no provider, so the account's own
   * zone listing picks which one hostnames are minted in.
   */
  readonly zoneNames: readonly string[];
  readonly subdomain?: string;
  readonly endpoint?: string;
  readonly fetch?: Fetcher;
  readonly webSocket?: (url: string, protocols: string[]) => WebSocket;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Envelope<Result> {
  readonly success?: boolean;
  readonly errors?: readonly { readonly message?: string }[];
  readonly result?: Result;
}

/** Every field is optional: the platform may omit any of them. */
interface TailFrame {
  readonly event?: {
    readonly request?: { readonly method?: string; readonly url?: string };
  };
  readonly eventTimestamp?: number;
  readonly logs?: readonly {
    readonly message?: readonly unknown[];
    readonly level?: string;
    readonly timestamp?: number;
  }[];
  readonly exceptions?: readonly {
    readonly name?: string;
    readonly message?: string;
    readonly timestamp?: number;
  }[];
  readonly outcome?: string;
}

type Attempt<Result> =
  | { readonly ok: true; readonly result: Result }
  | { readonly ok: false; readonly status: number; readonly message: string };

export class WorkersFunctions implements FunctionDeployer {
  readonly target: FunctionTarget = 'cloudflare-workers';

  private zone: { readonly name: string; readonly id: string } | null = null;

  constructor(private readonly options: WorkersFunctionsOptions) {}

  async hostname(name: string): Promise<string> {
    const subdomain = this.options.subdomain ?? DEFAULT_SUBDOMAIN;
    const zone = await this.resolveZone();
    return `${name}.${subdomain}.${zone.name}`;
  }

  async deploy(
    name: string,
    source: string,
    env: FunctionEnv,
  ): Promise<{ readonly url: string }> {
    const script = workloadName(name);
    const zone = await this.resolveZone();
    const hostname = await this.hostname(name);

    // A module Worker is its files plus a metadata part naming the entry.
    const body = new FormData();
    body.set(
      'metadata',
      new File(
        [
          JSON.stringify({
            main_module: 'index.mjs',
            compatibility_date: COMPATIBILITY_DATE,
            observability: {
              enabled: true,
              logs: { enabled: true, invocation_logs: true },
            },
            bindings: Object.entries(env).map(([name, text]) => ({
              type: 'secret_text',
              name,
              text,
            })),
          }),
        ],
        'metadata.json',
        { type: 'application/json' },
      ),
    );
    body.set(
      'index.mjs',
      new File([source], 'index.mjs', {
        type: 'application/javascript+module',
      }),
    );
    await this.call(
      'PUT',
      `/accounts/${this.options.accountId}/workers/scripts/${script}`,
      { body },
    );

    // Idempotent: the same hostname on the same script is the same domain.
    await this.call(
      'PUT',
      `/accounts/${this.options.accountId}/workers/domains`,
      {
        json: {
          hostname,
          service: script,
          zone_id: zone.id,
          environment: 'production',
        },
      },
    );

    // Secrets outlive an upload that omits them, so removed ones are deleted by
    // name. Listed after the upload, so a secret it just set is never deleted.
    const secrets = await this.call<readonly { readonly name?: string }[]>(
      'GET',
      `/accounts/${this.options.accountId}/workers/scripts/${script}/secrets`,
    );
    for (const secret of secrets ?? []) {
      if (secret.name === undefined || secret.name in env) continue;
      await this.gone(
        'DELETE',
        `/accounts/${this.options.accountId}/workers/scripts/${script}/secrets/${encodeURIComponent(secret.name)}`,
      );
    }

    return { url: `https://${hostname}` };
  }

  async remove(name: string): Promise<void> {
    const script = workloadName(name);
    const account = this.options.accountId;
    // Domain first: one that outlives its script keeps serving a 404.
    const domains = await this.attempt<readonly { readonly id?: string }[]>(
      'GET',
      `/accounts/${account}/workers/domains`,
      { query: { hostname: await this.hostname(name) } },
    );
    if (domains.ok) {
      for (const domain of domains.result ?? []) {
        if (domain.id === undefined) continue;
        await this.gone(
          'DELETE',
          `/accounts/${account}/workers/domains/${domain.id}`,
        );
      }
    } else if (domains.status !== 404) {
      throw new FunctionDeployError(domains.message);
    }
    await this.gone(
      'DELETE',
      `/accounts/${account}/workers/scripts/${script}`,
      { query: { force: 'true' } },
    );
  }

  /** Tail sessions expire, so a new one opens whenever the socket closes. */
  async *tail(
    name: string,
    signal: AbortSignal,
  ): AsyncGenerator<FunctionLogEntry, void, void> {
    const script = workloadName(name);
    const account = this.options.accountId;
    const open =
      this.options.webSocket ??
      ((url: string, protocols: string[]) => new WebSocket(url, protocols));
    const sleep = this.options.sleep ?? ((ms: number) => Bun.sleep(ms));
    let delay = RECONNECT_MIN_MS;

    while (!signal.aborted) {
      const session = await this.call<{
        readonly id?: string;
        readonly url?: string;
      }>('POST', `/accounts/${account}/workers/scripts/${script}/tails`);
      if (session.url === undefined) {
        throw new FunctionDeployError(
          `the platform opened a tail on ${script} without giving an address to read it at`,
        );
      }
      const socket = open(session.url, [TAIL_PROTOCOL]);
      try {
        for await (const entry of frames(socket, signal)) {
          delay = RECONNECT_MIN_MS;
          yield entry;
        }
      } finally {
        socket.close();
        if (session.id !== undefined) {
          // Best effort: a session left behind expires on its own.
          await this.attempt(
            'DELETE',
            `/accounts/${account}/workers/scripts/${script}/tails/${session.id}`,
          ).catch(() => {});
        }
      }
      if (signal.aborted) return;
      await sleep(delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  /** Read once: a zone added to the account is picked up on restart. */
  private async resolveZone(): Promise<{
    readonly name: string;
    readonly id: string;
  }> {
    if (this.zone !== null) return this.zone;
    const listed = await this.call<
      readonly { readonly id?: string; readonly name?: string }[] | undefined
    >('GET', '/zones', {
      query: { 'account.id': this.options.accountId, per_page: '50' },
    });
    const carried = (listed ?? [])
      .filter(
        (zone): zone is { id: string; name: string } =>
          zone.id !== undefined && zone.name !== undefined,
      )
      .map((zone) => ({ ...zone, status: 'unknown' }));
    const name = servableZone(this.options.zoneNames, carried);
    const chosen = carried.find((zone) => zone.name === name);
    if (chosen === undefined) {
      throw new FunctionDeployError(
        `this installation's Cloudflare token sees no zone in account ${
          this.options.accountId
        } matching any zone this installation declares (${
          this.options.zoneNames.join(', ') || 'none'
        })`,
      );
    }
    this.zone = { name: chosen.name, id: chosen.id };
    return this.zone;
  }

  private async call<Result>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Result> {
    const attempt = await this.attempt<Result>(method, path, options);
    if (!attempt.ok) throw new FunctionDeployError(attempt.message);
    return attempt.result;
  }

  /** As `call`, but a `404` means already gone. */
  private async gone(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<void> {
    const attempt = await this.attempt(method, path, options);
    if (!attempt.ok && attempt.status !== 404) {
      throw new FunctionDeployError(attempt.message);
    }
  }

  private async attempt<Result>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Attempt<Result>> {
    const url = new URL(
      `${this.options.endpoint ?? CLOUDFLARE_API_ROOT}${path}`,
    );
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${await this.options.token()}`,
    };
    // JSON only: for FormData, `Request` writes the header with its multipart
    // boundary, and one set here would make the body unparseable.
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const send = this.options.fetch ?? ((request: Request) => fetch(request));
    let response: Response;
    try {
      response = await send(
        new Request(url, {
          method,
          headers,
          body:
            options.body ??
            (options.json === undefined
              ? undefined
              : JSON.stringify(options.json)),
        }),
      );
    } catch (cause) {
      return {
        ok: false,
        status: 0,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
    const text = await response.text();
    let envelope: Envelope<Result> | null = null;
    try {
      envelope = JSON.parse(text) as Envelope<Result>;
    } catch {
      envelope = null;
    }
    if (!response.ok || envelope?.success === false) {
      return {
        ok: false,
        status: response.status,
        message:
          envelope?.errors?.find((error) => error.message !== undefined)
            ?.message ??
          (text.trim() === '' ? response.statusText : text.trim()),
      };
    }
    return { ok: true, result: envelope?.result as Result };
  }
}

interface RequestOptions {
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: FormData;
  readonly json?: unknown;
}

/**
 * A queue, because the socket keeps delivering while the consumer awaits the
 * previous line, and dropping those leaves holes in a busy function's logs.
 */
async function* frames(
  socket: WebSocket,
  signal: AbortSignal,
): AsyncGenerator<FunctionLogEntry, void, void> {
  const pending: FunctionLogEntry[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const nudge = (): void => {
    wake?.();
    wake = null;
  };
  const finish = (): void => {
    closed = true;
    nudge();
  };

  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    let frame: TailFrame;
    try {
      frame = JSON.parse(event.data) as TailFrame;
    } catch {
      return;
    }
    pending.push(...entriesOf(frame));
    nudge();
  };
  socket.onclose = finish;
  socket.onerror = finish;
  signal.addEventListener('abort', finish, { once: true });

  try {
    while (true) {
      while (pending.length > 0) yield pending.shift()!;
      if (closed || signal.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    signal.removeEventListener('abort', finish);
  }
}

function entriesOf(frame: TailFrame): FunctionLogEntry[] {
  const at = (timestamp: number | undefined): string =>
    new Date(timestamp ?? frame.eventTimestamp ?? Date.now()).toISOString();

  const entries: FunctionLogEntry[] = (frame.logs ?? []).map((log) => ({
    at: at(log.timestamp),
    line: (log.message ?? []).map(render).join(' '),
    level: levelOf(log.level),
  }));

  for (const exception of frame.exceptions ?? []) {
    entries.push({
      at: at(exception.timestamp),
      line: `${exception.name ?? 'Error'}: ${exception.message ?? ''}`,
      level: 'error',
    });
  }

  // Last, so the request's own lines read above the verdict on them.
  const request = frame.event?.request;
  if (request !== undefined) {
    entries.push({
      at: at(undefined),
      line: `${request.method ?? 'GET'} ${pathOf(request.url)} → ${
        frame.outcome ?? 'unknown'
      }`,
      level: 'info',
    });
  }
  return entries;
}

function levelOf(level: string | undefined): FunctionLogEntry['level'] {
  switch (level) {
    case 'info':
    case 'warn':
    case 'error':
    case 'debug':
      return level;
    default:
      return 'log';
  }
}

function pathOf(url: string | undefined): string {
  if (url === undefined) return '/';
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
