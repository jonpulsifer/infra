/**
 * Functions: a JavaScript `fetch` handler deployed as one public endpoint, not
 * an App. Only an enrolled operator can write one, so the preview has to stop a
 * runaway loop, not a hostile author.
 *
 * ponytail: one table and two deployers, and a sealed environment. Promote to a
 * Component kind when a function needs a Datastore or a build.
 */

export const FUNCTION_TARGETS = [
  'cloudflare-workers',
  'cloud-run-functions',
] as const;

export type FunctionTarget = (typeof FUNCTION_TARGETS)[number];

/**
 * Short enough that `fn-` plus the name fits the 63-byte limit on Workers
 * script names, Cloud Run service ids and DNS labels.
 */
export const FUNCTION_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const FUNCTION_NAME_PREFIX = 'fn-';

/**
 * Write-only from the browser: a value is set and never returned, so a screen
 * knows only the keys.
 */
export type FunctionEnv = Readonly<Record<string, string>>;

/**
 * What a JavaScript property access, a Workers binding and a Cloud Run
 * environment key all accept, at a length every platform takes.
 */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * `/functions/new` is the create route, so a function called `new` would have
 * no address.
 */
export const RESERVED_FUNCTION_NAMES: ReadonlySet<string> = new Set(['new']);

/** The platform-side name of a function: what a script or service is called. */
export function workloadName(name: string): string {
  return `${FUNCTION_NAME_PREFIX}${name}`;
}

export const FUNCTION_CONTRACT = 'export default { fetch(request, env) }';

export interface FunctionLogEntry {
  /** ISO 8601. */
  readonly at: string;
  readonly line: string;
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
}

/** A platform refusal or failure, in a sentence an operator can act on. */
export class FunctionDeployError extends Error {
  override readonly name = 'FunctionDeployError';
}

export interface FunctionDeployer {
  readonly target: FunctionTarget;
  /** Create or replace the function; resolves with the URL it answers on. */
  deploy(
    name: string,
    source: string,
    env: FunctionEnv,
  ): Promise<{ readonly url: string }>;
  /** Idempotent: a function that is already gone is not an error. */
  remove(name: string): Promise<void>;
  /** Live lines until `signal` aborts, staying open while nothing is logged. */
  tail(
    name: string,
    signal: AbortSignal,
  ): AsyncGenerator<FunctionLogEntry, void, void>;
}

/** `null` where the installation declares no surface of that kind. */
export type FunctionDeployers = Readonly<
  Record<FunctionTarget, FunctionDeployer | null>
>;

export interface PreviewRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface PreviewResult {
  /** `true` when the handler returned a Response; a throw or a timeout is `false`. */
  readonly ok: boolean;
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  /** Response text, cut at {@link PREVIEW_BODY_LIMIT}. */
  readonly body: string;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly logs: readonly FunctionLogEntry[];
  readonly durationMs: number;
}

export const PREVIEW_TIMEOUT_MS = 10_000;

export const PREVIEW_BODY_LIMIT = 64 * 1024;
