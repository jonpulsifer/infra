/**
 * Asks the cloud what this installation already has (projects, buckets and KMS
 * signing keys), so an operator confirms manifest values instead of typing them.
 */
import {
  CloudHttp,
  type CloudResponse,
  type Fetcher,
  type TokenProvider,
} from './deploy/cloud/http.ts';

const RESOURCE_MANAGER = 'https://cloudresourcemanager.googleapis.com';
const STORAGE = 'https://storage.googleapis.com';
const KEY_MANAGEMENT = 'https://cloudkms.googleapis.com';

/** The reason code for a disabled API. Some calls carry it only in the message. */
const SERVICE_DISABLED = 'SERVICE_DISABLED';

/** A symmetric key validates as a signer, then fails at the first cosign call. */
const SIGNING_PURPOSE = 'ASYMMETRIC_SIGN';

/**
 * ponytail: fixed caps on pages and key rings. Reaching one reports
 * `unavailable`, so a truncated list never looks complete.
 */
const MAX_PAGES = 20;
const MAX_KEY_RINGS = 20;

/**
 * A failed read is `unavailable`, never an empty `found`. `suggested` is set
 * only when there is one candidate.
 */
export type Discovered<Value> =
  | {
      readonly kind: 'found';
      readonly candidates: readonly Value[];
      readonly suggested: Value | null;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** What was being asked about, in the sentence an operator reads. */
interface Subject {
  /** What the service is called where an operator would go to enable it. */
  readonly service: string;
  /** What was being listed, named for the refusal sentence. */
  readonly scope: string;
}

type Listing<Item> =
  | { readonly ok: true; readonly items: readonly Item[] }
  | { readonly ok: false; readonly reason: string };

/** Each API names its array differently, and every one carries `nextPageToken`. */
type Page = Record<string, unknown>;

export interface GcpDiscoveryOptions {
  /** Mints a bearer token per request, never a stored credential. */
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
}

/** Each read answers `found` or `unavailable` and never throws. */
export class GcpDiscovery {
  private readonly resourceManager: CloudHttp;
  private readonly storage: CloudHttp;
  private readonly keyManagement: CloudHttp;

  constructor(options: GcpDiscoveryOptions) {
    const client = (baseUrl: string) =>
      new CloudHttp({
        baseUrl,
        token: options.token,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    this.resourceManager = client(RESOURCE_MANAGER);
    this.storage = client(STORAGE);
    this.keyManagement = client(KEY_MANAGEMENT);
  }

  /** Every project this identity can see, active ones only. */
  async projects(): Promise<Discovered<string>> {
    const listed = await this.collect<{
      projectId?: string;
      lifecycleState?: string;
    }>(
      this.resourceManager,
      {
        service: 'Resource Manager',
        scope: 'the projects this identity holds',
      },
      '/v1/projects',
      (page) =>
        (page.projects as
          | { projectId?: string; lifecycleState?: string }[]
          | undefined) ?? [],
    );
    if (!listed.ok) return unavailable(listed.reason);
    // A project pending deletion is still listed and cannot be deployed to.
    return found(
      listed.items
        .filter((project) => (project.lifecycleState ?? 'ACTIVE') === 'ACTIVE')
        .flatMap((project) =>
          project.projectId === undefined ? [] : [project.projectId],
        ),
    );
  }

  async buckets(project: string): Promise<Discovered<string>> {
    const listed = await this.collect<{ name?: string }>(
      this.storage,
      { service: 'Cloud Storage', scope: `the buckets in ${project}` },
      '/storage/v1/b',
      (page) => (page.items as { name?: string }[] | undefined) ?? [],
      { project },
    );
    if (!listed.ok) return unavailable(listed.reason);
    return found(
      listed.items.flatMap((bucket) =>
        bucket.name === undefined ? [] : [bucket.name],
      ),
    );
  }

  /**
   * Key rings are listed per location, so a caller picks a location here instead
   * of fanning out over every one.
   */
  async keyLocations(project: string): Promise<Discovered<string>> {
    const listed = await this.collect<{ locationId?: string }>(
      this.keyManagement,
      { service: 'Cloud KMS', scope: `the key locations of ${project}` },
      `/v1/projects/${encodeURIComponent(project)}/locations`,
      (page) => (page.locations as { locationId?: string }[] | undefined) ?? [],
    );
    if (!listed.ok) return unavailable(listed.reason);
    return found(
      listed.items.flatMap((location) =>
        location.locationId === undefined ? [] : [location.locationId],
      ),
    );
  }

  /**
   * Signing keys as `gcpkms://` plus the key's resource name, the signer form.
   * ponytail: one call per key ring, in sequence; a refused ring fails the read.
   */
  async signingKeys(
    project: string,
    location: string,
  ): Promise<Discovered<string>> {
    const where = `${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}`;
    const subject = {
      service: 'Cloud KMS',
      scope: `the signing keys in ${project} at ${location}`,
    };
    const rings = await this.collect<{ name?: string }>(
      this.keyManagement,
      subject,
      `/v1/projects/${where}/keyRings`,
      (page) => (page.keyRings as { name?: string }[] | undefined) ?? [],
    );
    if (!rings.ok) return unavailable(rings.reason);

    const names = rings.items.flatMap((ring) =>
      ring.name === undefined ? [] : [ring.name],
    );
    if (names.length > MAX_KEY_RINGS) {
      return unavailable(
        `${subject.scope} span ${names.length} key rings, more than discovery will open in one pass`,
      );
    }

    const keys: string[] = [];
    for (const ring of names) {
      const listed = await this.collect<{ name?: string; purpose?: string }>(
        this.keyManagement,
        subject,
        `/v1/${ring}/cryptoKeys`,
        (page) =>
          (page.cryptoKeys as
            | { name?: string; purpose?: string }[]
            | undefined) ?? [],
      );
      if (!listed.ok) return unavailable(listed.reason);
      for (const key of listed.items) {
        if (key.purpose !== SIGNING_PURPOSE || key.name === undefined) continue;
        keys.push(`gcpkms://${key.name}`);
      }
    }
    return found(keys);
  }

  /** Walks a paginated listing to the end, up to {@link MAX_PAGES} pages. */
  private async collect<Item>(
    http: CloudHttp,
    subject: Subject,
    path: string,
    items: (page: Page) => readonly Item[],
    query: Readonly<Record<string, string>> = {},
  ): Promise<Listing<Item>> {
    const collected: Item[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const response = await http.json<Page>({
        method: 'GET',
        path,
        query: { ...query, ...(pageToken === undefined ? {} : { pageToken }) },
      });
      if (!response.ok)
        return { ok: false, reason: reasonFor(response, subject) };
      const page: Page = response.value ?? {};
      collected.push(...items(page));
      const next = page.nextPageToken;
      pageToken = typeof next === 'string' && next !== '' ? next : undefined;
      pages += 1;
      if (pages >= MAX_PAGES && pageToken !== undefined) {
        return {
          ok: false,
          reason: `${subject.scope} did not finish listing within ${MAX_PAGES} pages`,
        };
      }
    } while (pageToken !== undefined);

    return { ok: true, items: collected };
  }
}

/** A refused read as the sentence an operator acts on. */
function reasonFor(
  failure: Extract<CloudResponse<unknown>, { ok: false }>,
  subject: Subject,
): string {
  if (failure.kind === 'transport') {
    return `${subject.service} could not be reached: ${failure.message}`;
  }
  if (
    failure.reason === SERVICE_DISABLED ||
    failure.body.includes(SERVICE_DISABLED)
  ) {
    // ErrorInfo names the project whose API is off, which is often the token's
    // own project.
    return failure.consumer === null
      ? `the ${subject.service} API is not enabled, so ${subject.scope} could not be listed`
      : `the ${subject.service} API is not enabled in ${failure.consumer} — the project this installation's calls bill to — so ${subject.scope} could not be listed`;
  }
  if (failure.status === 401 || failure.status === 403) {
    return `the federated identity may not list ${subject.scope}: ${failure.message}`;
  }
  if (failure.status === 404) {
    return `${subject.scope} could not be found`;
  }
  return `${subject.service} answered ${failure.status}: ${failure.message}`;
}

function found(candidates: readonly string[]): Discovered<string> {
  return {
    kind: 'found',
    candidates,
    suggested: candidates.length === 1 ? (candidates[0] ?? null) : null,
  };
}

function unavailable(reason: string): Discovered<string> {
  return { kind: 'unavailable', reason };
}
