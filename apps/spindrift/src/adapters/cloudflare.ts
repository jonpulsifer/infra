/**
 * Reading a connected Cloudflare account — the boundary, not a surface on it.
 *
 * `deploy/pages` reads what Pages needs and `functions/workers` reads what a
 * Worker needs, and between them nothing ever asked the *account* what it
 * carries. That gap is why an operator connecting one saw a form with a single
 * field and a card that named one product: the connection was account-shaped in
 * the domain and Pages-shaped everywhere a human could see it.
 *
 * Three listings, one credential, one pass. Each is folded into its own field
 * with its own sentence — never one `try` around all three, for the reason
 * `vessel-loop.ts` gives about four cloud reads: a single catch turns two good
 * answers into three refusals.
 *
 * **Read-only, and every call is a `GET`.** This is the account's inventory as
 * its own token can see it; §14's rule that Spindrift does not switch a
 * vendor's products on is exactly as binding here as it is for a project's
 * disabled API.
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

/**
 * The platform's own API root — one hostname for every account, because
 * Cloudflare runs a single control plane rather than one per customer.
 *
 * Lives here rather than in `deploy/pages` now that the connection it belongs
 * to is the account's: Pages, Workers and the zone listing all reach the same
 * root, and one of the three owning the constant is what made the other two
 * import from a deploy adapter to get at it.
 */
export const CLOUDFLARE_API_ROOT = 'https://api.cloudflare.com/client/v4';

/** How many zones or projects one listing brings back. */
const PAGE_SIZE = '50';

export interface CloudflareAccountOptions {
  /** Mints the account credential per call. Never a stored one (§13). */
  readonly token: TokenProvider;
  /** The API root, override or {@link CLOUDFLARE_API_ROOT}. */
  readonly endpoint?: string;
  /** Injected so a test can stand a fake far side behind the real client. */
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

/** One zone as the API lists it — every field is the platform's option. */
interface ZoneRow {
  readonly id?: string;
  readonly name?: string;
  readonly status?: string;
}

/** One Pages project, of which only the name is wanted here. */
interface ProjectRow {
  readonly name?: string;
}

/** Never throws: a boundary that will not answer is a sentence, not a fault. */
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
    // Scoped to the account rather than to the token: a token with access to
    // two accounts would otherwise list the other one's zones under this
    // boundary, which is the one way this listing could lie.
    http.json<Envelope<readonly ZoneRow[]>>({
      method: 'GET',
      path: '/zones',
      query: { 'account.id': account, per_page: PAGE_SIZE },
    }),
    http.json<Envelope<{ readonly subdomain?: string }>>({
      method: 'GET',
      path: `${scope}/workers/subdomain`,
    }),
    // No pagination options: the live endpoint refuses `page`/`per_page`
    // (error 8000024, "Invalid list options provided") despite documenting
    // them, so this listing is whatever the platform's default page carries.
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

  // The display name quietly: a token without account-read scope still reads
  // zones, and a missing pretty name is not a gap an operator should chase.
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

/** The zones that carry the two fields anything downstream addresses them by. */
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
 * The platform's own words, out of its envelope.
 *
 * `CloudHttp`'s generic message reader speaks the Google shape, so a
 * Cloudflare refusal reaches it as the whole raw body — a JSON blob nobody
 * should have to read. Cloudflare's envelope is `{ errors: [{ code, message }] }`;
 * where the body parses as one, the messages are the sentence. Anything else
 * falls back to the generic reading.
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
