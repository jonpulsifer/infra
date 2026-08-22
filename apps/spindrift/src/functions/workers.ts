/**
 * Deploying a function to Cloudflare Workers.
 *
 * The script is uploaded as an ES module and given a **custom domain** rather
 * than a route: a custom domain makes the platform own the hostname's record
 * and its certificate, so nothing here writes DNS and §9's "Spindrift holds no
 * zone credential" survives a feature that hands out hostnames. Which zone that
 * is, is the account's answer rather than the manifest's first entry: the
 * account's own zone listing is read once per instance and the first declared
 * zone it carries is the one hostnames are minted in.
 *
 * `tail` opens the platform's own trace websocket. A tail session expires on
 * its own schedule, so the generator reopens one whenever the socket closes
 * without the caller having aborted — a viewer left open overnight keeps
 * receiving lines instead of going quiet at the hour mark.
 *
 * The function's environment travels as `secret_text` bindings on the metadata
 * part. Measured, not assumed: the platform keeps a secret across uploads even
 * when the new metadata lists none, so a variable the operator removed is
 * removed by name through the secrets API after the upload — the same Save
 * that took it off the row takes it off the script.
 *
 * ponytail: no per-function compatibility flags. That is a field on the
 * metadata part when a function needs one.
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
 * What the runtime is compiled against.
 *
 * Pinned rather than "today": a compatibility date is the platform's own
 * versioning, and one that moved with the wall clock would change a deployed
 * function's behaviour on a redeploy nobody asked for.
 */
const COMPATIBILITY_DATE = '2026-08-01';

/** The label between the function's name and the zone: `<name>.fn.<zone>`. */
const DEFAULT_SUBDOMAIN = 'fn';

/** The protocol the trace socket speaks. */
const TAIL_PROTOCOL = 'trace-v1';

/**
 * How long a closed tail waits before a new session is minted — doubling up
 * to the ceiling while the far side keeps closing, back to the floor once a
 * frame arrives. A session that dies on arrival would otherwise re-mint
 * itself as fast as the platform answers, for as long as a viewer is open.
 */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface WorkersFunctionsOptions {
  readonly token: TokenProvider;
  readonly accountId: string;
  /**
   * The zones this installation declares, in the order it declares them.
   *
   * A list rather than one name, because `dns.zones` is the installation's
   * naming policy (§9) and says nothing about which provider answers for each
   * entry — an installation with a private zone on a resolver of its own and a
   * public one here declares both. Which of them this account actually carries
   * is the account's answer, read once by {@link WorkersFunctions.resolveZone}.
   */
  readonly zoneNames: readonly string[];
  readonly subdomain?: string;
  readonly endpoint?: string;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  readonly webSocket?: (url: string, protocols: string[]) => WebSocket;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The envelope every response from this API carries. */
interface Envelope<Result> {
  readonly success?: boolean;
  readonly errors?: readonly { readonly message?: string }[];
  readonly result?: Result;
}

/** One tail frame, read defensively — every field is the platform's option. */
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

  /** `<name>.<subdomain>.<zone>` — the address the function answers on. */
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

    // Multipart, because a module Worker is uploaded as the files it is made
    // of plus a metadata part naming which one is the entry.
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
            // Always sent, empty included: the list is the whole environment,
            // so a variable the operator removed is removed from the script by
            // the same upload — an omitted key would leave the old one live.
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

    // Idempotent on the platform's side: the same hostname pointed at the same
    // script is the same domain, so a redeploy is not a second one.
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

    // Secrets outlive an upload that does not name them, so the ones the
    // environment no longer holds are deleted by name. Listed after the upload
    // so a secret the upload just set is never in the to-delete set.
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
    // The custom domain goes first: a domain outliving its script is a
    // hostname that resolves to a 404 the platform will keep serving.
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
          // Best effort: a session left behind expires on its own, and a
          // failure here must not be what the viewer sees.
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

  /**
   * The declared zone this account actually carries, read once.
   *
   * The account's own listing rather than a lookup of one name, because the
   * question is which of the declared zones is *here*. Taking the head of the
   * declared list and asking for it by name gave the platform a zone it had
   * never heard of whenever the installation's first zone was somebody else's,
   * and the refusal named that zone rather than the mismatch.
   *
   * Read once: a zone is not renamed mid-process, and a zone added to the
   * account during one is picked up by the next restart — the same staleness
   * every other cached far-side fact here carries.
   */
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

  /** As {@link call}, but a `404` is an answer rather than a refusal. */
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
    // `Request` derives the multipart boundary from the `FormData` and writes
    // the header itself; a `Content-Type` set here would make the body
    // unparseable on the far side.
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
  /** A multipart body, sent as-is. */
  readonly body?: FormData;
  /** A JSON body, serialized with the header the API needs. */
  readonly json?: unknown;
}

/**
 * The socket's frames as lines, in arrival order.
 *
 * A queue rather than an event-per-yield, because the socket keeps delivering
 * while the consumer is awaiting the previous line and dropping those is how a
 * busy function's logs come out with holes in them.
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

/** One frame as the lines a reader sees: logs, then throws, then the verdict. */
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
