/**
 * Reads a connected Cloudflare account: its name, zones, Workers subdomain and
 * Pages projects. Every call is a `GET`, and each listing fails on its own.
 */
import type {
  CloudflareAccountDiscovery,
  CloudflareZone,
} from '../domain/vessel.ts';
import {
  CloudHttp,
  type CloudResponse,
  type Fetcher,
  type TokenProvider,
} from './deploy/cloud/http.ts';
import type { CloudFailure } from './deploy/cloud/verdict.ts';
import { type Envelope, unwrap } from './deploy/pages/assets.ts';

/** One API root serves every account. */
export const CLOUDFLARE_API_ROOT = 'https://api.cloudflare.com/client/v4';

/** Zones per listing; only the first page is read. */
const PAGE_SIZE = '50';

export interface CloudflareAccountOptions {
  /** Mints the account credential per call, never a stored one. */
  readonly token: TokenProvider;
  /** Defaults to {@link CLOUDFLARE_API_ROOT}. */
  readonly endpoint?: string;
  readonly fetch?: Fetcher;
}

/** What the vessel loop and the connect act both reach the account through. */
export interface CloudflareAccounts {
  read(
    account: string,
    options?: { readonly endpoint?: string },
  ): Promise<CloudflareAccountDiscovery>;
}

export function cloudflareAccounts(
  options: CloudflareAccountOptions,
): CloudflareAccounts {
  return {
    read: (account, read) =>
      readCloudflareAccount(account, {
        ...options,
        ...(read?.endpoint === undefined ? {} : { endpoint: read.endpoint }),
      }),
  };
}

/** Every field may be absent from the API's answer. */
interface ZoneRow {
  readonly id?: string;
  readonly name?: string;
  readonly status?: string;
}

interface ProjectRow {
  readonly name?: string;
}

/** Never throws: a refused listing becomes a sentence in `unreadable`. */
export async function readCloudflareAccount(
  account: string,
  options: CloudflareAccountOptions,
): Promise<CloudflareAccountDiscovery> {
  const http = new CloudHttp({
    baseUrl: options.endpoint ?? CLOUDFLARE_API_ROOT,
    token: options.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const scope = `/accounts/${encodeURIComponent(account)}`;

  const [named, zones, subdomain, projects] = await Promise.all([
    http.json<Envelope<{ readonly name?: string }>>({
      method: 'GET',
      path: scope,
    }),
    // Scoped to the account: a token for two accounts would list the other's zones.
    http.json<Envelope<readonly ZoneRow[]>>({
      method: 'GET',
      path: '/zones',
      query: { 'account.id': account, per_page: PAGE_SIZE },
    }),
    http.json<Envelope<{ readonly subdomain?: string }>>({
      method: 'GET',
      path: `${scope}/workers/subdomain`,
    }),
    // The endpoint refuses `page` and `per_page` (error 8000024) despite
    // documenting them, so only the default page is read.
    http.json<Envelope<readonly ProjectRow[]>>({
      method: 'GET',
      path: `${scope}/pages/projects`,
    }),
  ]);

  const unreadable: Record<string, string> = {};
  const read = <Result, Value>(
    field: string,
    response: CloudResponse<Envelope<Result> | undefined>,
    value: (result: Result | undefined) => Value,
  ): Value | null => {
    const outcome = unwrap(response);
    if (!outcome.ok) {
      unreadable[field] = sentenceOf(outcome.failure);
      return null;
    }
    return value(outcome.value);
  };

  // The name is optional: a token without account-read scope still reads zones.
  const namedOutcome = unwrap(named);
  const accountName =
    namedOutcome.ok && typeof namedOutcome.value?.name === 'string'
      ? namedOutcome.value.name
      : null;

  const discovery: CloudflareAccountDiscovery = {
    kind: 'cloudflare-account',
    accountName,
    zones: read('zones', zones, (listed) => zonesOf(listed)),
    workersSubdomain: read(
      'workersSubdomain',
      subdomain,
      (result) => result?.subdomain ?? null,
    ),
    pagesProjects: read('pagesProjects', projects, (listed) =>
      (listed ?? [])
        .map((project) => project.name)
        .filter((name): name is string => name !== undefined),
    ),
  };
  return Object.keys(unreadable).length === 0
    ? discovery
    : { ...discovery, unreadable };
}

/** Zones with both a name and an id; downstream addresses a zone by both. */
function zonesOf(listed: readonly ZoneRow[] | undefined): CloudflareZone[] {
  return (listed ?? [])
    .filter(
      (zone): zone is ZoneRow & { name: string; id: string } =>
        zone.name !== undefined && zone.id !== undefined,
    )
    .map((zone) => ({
      name: zone.name,
      id: zone.id,
      status: zone.status ?? 'unknown',
    }));
}

/** One refusal as the operator reads it, with the status where there was one. */
function sentenceOf(failure: CloudFailure): string {
  if (failure.kind !== 'status') return failure.message;
  return `${failure.status}: ${envelopeErrors(failure.body) ?? failure.message}`;
}

/**
 * The messages in Cloudflare's `{ errors: [{ code, message }] }` envelope, or
 * `null` to fall back to `CloudHttp`'s generic reading.
 */
function envelopeErrors(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const errors = (parsed as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return null;
  const said = errors
    .map((error: unknown) =>
      error !== null &&
      typeof error === 'object' &&
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : null,
    )
    .filter((message): message is string => message !== null)
    .join('; ');
  return said === '' ? null : said;
}
