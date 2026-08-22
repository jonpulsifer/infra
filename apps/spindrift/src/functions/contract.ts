/**
 * Functions — a JavaScript `fetch` handler deployed as one public endpoint.
 *
 * Not an App. A function has no Build, no Deploy row and no Vessel admission:
 * the editor holds text, Save pushes that text to one of two surfaces the
 * installation already reaches — Cloudflare Workers with the installation's
 * Cloudflare bearer, or Cloud Run functions with the home vessel's federated
 * identity — and the row remembers the URL that came back. The feature is
 * admitted on a trusted-author basis: the only person who can write one is an
 * enrolled operator, so the preview sandbox stops a runaway loop rather than a
 * hostile author.
 *
 * ponytail: one table and two deployers. Promote to a Component kind when a
 * function needs config, secrets, or a Datastore.
 */

export const FUNCTION_TARGETS = [
  'cloudflare-workers',
  'cloud-run-functions',
] as const;

export type FunctionTarget = (typeof FUNCTION_TARGETS)[number];

/**
 * A DNS label short enough that `fn-` + name clears every platform's 63-byte
 * ceiling — Workers script names, Cloud Run service ids and hostname labels
 * alike.
 */
export const FUNCTION_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const FUNCTION_NAME_PREFIX = 'fn-';

/**
 * Names the editor's own routes spend: `/functions/new` is where a function
 * is created, so a function called `new` would have no address of its own.
 */
export const RESERVED_FUNCTION_NAMES: ReadonlySet<string> = new Set(['new']);

/** The platform-side name of a function: what a script or service is called. */
export function workloadName(name: string): string {
  return `${FUNCTION_NAME_PREFIX}${name}`;
}

/** The one shape an author writes, on both surfaces. */
export const FUNCTION_CONTRACT = 'export default { fetch(request, env) }';

export interface FunctionLogEntry {
  /** ISO 8601. */
  readonly at: string;
  readonly line: string;
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
}

/** A deploy the platform refused or could not finish, in operator words. */
export class FunctionDeployError extends Error {
  override readonly name = 'FunctionDeployError';
}

export interface FunctionDeployer {
  readonly target: FunctionTarget;
  /**
   * Create or replace the function, resolving with the URL it answers on.
   * Rejects with {@link FunctionDeployError} carrying a sentence an operator
   * can act on.
   */
  deploy(name: string, source: string): Promise<{ readonly url: string }>;
  /** Idempotent: a function that is already gone is not an error. */
  remove(name: string): Promise<void>;
  /**
   * Live lines until `signal` aborts. A function nothing has invoked yields
   * nothing rather than ending.
   */
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
