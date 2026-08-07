/**
 * Asking the cloud what this installation already is (§13, §20).
 *
 * §20 puts every value naming an installation in the manifest, and until now
 * every one of them was typed there by hand — including the ones the pod's own
 * federated identity could simply be asked for. A mistyped project or bucket is
 * invisible until a build stages a source archive and fails on a signed URL, so
 * the value of asking is not convenience: it is that a confirmed answer cannot
 * be a typo.
 *
 * **The two arms are the whole point.** A read either produced an answer or it
 * did not, and those are different types rather than the same list at different
 * lengths. `{ kind: 'found', candidates: [] }` says *this project has no
 * buckets* — a fact an operator can act on. A `403`, a disabled API, a DNS
 * failure or an absent federation say *nothing was established*, and collapsing
 * them into an empty array would put an empty value on a confirmation screen
 * that reads exactly like an answer. This is `cloudChecklist`'s rule in
 * `deploy/cloud/checklist.ts` — "an item that could not be assessed is reported
 * unmet, with a detail saying so rather than asserting a fault it did not
 * observe" — with `unavailable` in place of `unmet`.
 *
 * **No credential here, and no second one anywhere.** The token is a provider
 * called per request, exactly as the two cloud deploy adapters and the cloud
 * build route take it, and `registry.ts` hands all four the same one — so the
 * hourly STS-and-impersonation exchange in `deploy/cloud/federation.ts` is made
 * once for the process rather than once per discovery call.
 *
 * **A concrete class, not an interface.** § Seam 2's pattern is "a fake of the
 * far-side HTTP API behind the real client, with the test asserting the requests
 * that were made", which {@link CloudHttp}'s injected transport already gives.
 * An interface over one implementation would only move the seam somewhere it is
 * not needed. For the same reason the three API hosts are constants rather than
 * options: a test stands its fake behind `fetch` and answers these hostnames,
 * and an installation behind a service perimeter would need an override here —
 * which is a change to make when one exists, not before.
 */
import {
  CloudHttp,
  type CloudResponse,
  type Fetcher,
  type TokenProvider,
} from './deploy/cloud/http.ts';

/** Where the three APIs discovery reads live. Named by the software, always. */
const RESOURCE_MANAGER = 'https://cloudresourcemanager.googleapis.com';
const STORAGE = 'https://storage.googleapis.com';
const KEY_MANAGEMENT = 'https://cloudkms.googleapis.com';

/**
 * The reason code a cloud API uses for "this service is not turned on here".
 *
 * Matched as a substring as well as a parsed reason, for the reason
 * `checklist.ts` gives: the same fact arrives as a `reason` detail on some calls
 * and only inside the message on others, and an operator whose project has the
 * API switched off must not be told they lack a permission that is correct.
 */
const SERVICE_DISABLED = 'SERVICE_DISABLED';

/**
 * The purpose a key must have to sign anything.
 *
 * Filtered rather than offered, because a symmetric encryption key produces a
 * `supplyChain.signer` that validates, saves, reconciles, and then fails at the
 * first cosign call — the invisible-until-a-build-fails shape discovery exists
 * to remove.
 */
const SIGNING_PURPOSE = 'ASYMMETRIC_SIGN';

/**
 * How many pages a listing will walk, and how many key rings it will open.
 *
 * ponytail: fixed caps rather than a budget, because the far side is a paging
 * API answering a confirmation screen. Hitting either is reported as
 * `unavailable` rather than silently truncated — a short list that looks
 * complete is the same defect as an empty one that looks like an answer. Raise
 * them if a real installation ever reaches one.
 */
const MAX_PAGES = 20;
const MAX_KEY_RINGS = 20;

/**
 * What one read produced.
 *
 * `suggested` is the one candidate most likely right, and the rule for it here
 * is the only one this layer can honestly apply: where exactly one thing exists,
 * that is the answer. Anything richer — a heuristic drawn from the credential,
 * say — belongs to the caller that holds the fact it is drawn from.
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

/** A listing that either completed or has a sentence saying why it did not. */
type Listing<Item> =
  | { readonly ok: true; readonly items: readonly Item[] }
  | { readonly ok: false; readonly reason: string };

/**
 * A page of any of these APIs.
 *
 * Read structurally rather than typed per call: the three APIs name their array
 * differently — `projects`, `items`, `locations`, `keyRings`, `cryptoKeys` — and
 * every one of them carries `nextPageToken`, which is the only key the paging
 * loop itself has to understand.
 */
type Page = Record<string, unknown>;

export interface GcpDiscoveryOptions {
  /** Mints a bearer token per request. Never a stored credential (§13). */
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
}

/** The reads discovery makes, each answering both arms and never throwing. */
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
    // A project pending deletion is still listed and cannot be deployed to;
    // offering one would put a name on a confirmation screen that stops
    // resolving part way through the month.
    return found(
      listed.items
        .filter((project) => (project.lifecycleState ?? 'ACTIVE') === 'ACTIVE')
        .flatMap((project) =>
          project.projectId === undefined ? [] : [project.projectId],
        ),
    );
  }

  /** Every storage bucket in one project. */
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
   * The key locations one project offers.
   *
   * Not a manifest value itself — it is what makes {@link signingKeys}
   * answerable. Key rings are listed per concrete location, so a caller with no
   * location either names one or reads this list to pick from; fanning out over
   * every location would be forty calls behind one confirm button.
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
   * Every key in one project and location that can sign, as a signer reference.
   *
   * The reference is `gcpkms://` prefixed to the key's own resource name,
   * verbatim, because that is the exact form the placeholder manifest and every
   * real one already carry — assembling the six segments by hand is where a typo
   * becomes a signing failure nothing catches until a build.
   *
   * ponytail: one call per key ring, sequentially. Key rings in a single
   * project and location are one permission and there are rarely more than a
   * handful; a ring that refuses stops the read rather than being skipped,
   * because a partial key list offered as complete is the defect this file is
   * about.
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

  /**
   * Walk one paginated listing to the end.
   *
   * Paginated because these APIs are: a single-page read of a project's buckets
   * answers a short list that looks complete, which on a confirmation screen is
   * indistinguishable from the truth. The loop is the one
   * `store/gcp-secret-manager.ts` already runs, with a cap on it — a hostile or
   * broken far side that keeps handing out continuation tokens gets a stated
   * refusal rather than an unbounded loop.
   */
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

/**
 * Fold a refused read into the sentence an operator reads.
 *
 * The table is `cloudChecklist`'s, for the same reason: the shape of the refusal
 * is the one thing a cloud API is reliably precise about, and each shape sends
 * an operator somewhere different. A disabled service is a switch in a console;
 * a `403` is an IAM grant; a `404` is a project that is not there. Telling them
 * apart is the whole difference between a fact and a shrug.
 */
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
    // The refusal's ErrorInfo names the project whose switch is off — the
    // federated token's own, routinely not the one the call was aimed at.
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

/** An answer, with the only suggestion this layer can honestly make. */
function found(candidates: readonly string[]): Discovered<string> {
  return {
    kind: 'found',
    candidates,
    suggested: candidates.length === 1 ? (candidates[0] ?? null) : null,
  };
}

/** No answer, and the reason there is none. Never an empty list. */
function unavailable(reason: string): Discovered<string> {
  return { kind: 'unavailable', reason };
}
