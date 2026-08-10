/**
 * A fake static-hosting API (Task 29, § Seam 2).
 *
 * "A fake of the far-side HTTP API behind the real client, with the test
 * asserting the requests that were made" — so the adapter's real five-step
 * release, its real hashing, and its real bundle reading all run.
 *
 * Three behaviours are modelled because the adapter depends on all three:
 *
 * - **`populateFiles` asks for the hashes it does not already hold**, which is
 *   what makes a redeploy of an unchanged site cheap. A fake that always asked
 *   for everything would let an adapter that ignored the answer pass.
 * - **A version has to be finalized before a release will take it**, because
 *   that ordering is the product's whole contract about immutability and an
 *   adapter that released a draft would silently serve nothing.
 * - **The bundle is served from wherever the artifact says it is**, over the
 *   same injected transport, because the adapter fetching its own artifact is a
 *   real step that a fake API alone would leave untested.
 */
import type { Fetcher } from '../../../src/adapters/deploy/cloud/http.ts';
import { CLOUD_ENDPOINTS } from '../installation.ts';

export interface RecordedHostingRequest {
  method: string;
  url: string;
  path: string;
  body: unknown;
}

export interface FakeHostingOptions {
  readonly project?: string;
  /** Sites that already exist, by id. */
  readonly sites?: readonly string[];
  /**
   * A site that appears between the adapter's read and its create.
   *
   * The create race: two deploys of a new App, or a retry after a timeout
   * that did land. The read says missing, the create says `ALREADY_EXISTS`,
   * and the desired state is true either way — so this exists to prove the
   * adapter treats it that way rather than failing on a site it wanted.
   */
  readonly appearsBeforeCreate?: string;
  /** Hashes the product already holds, so it will not ask for them again. */
  readonly held?: readonly string[];
  /**
   * The artifact depot, and the bundle every address under it serves.
   *
   * Matched by origin rather than by exact URL because a `files` artifact is
   * addressed by its own digest: a fake keyed on one URL would have to be
   * rebuilt for every digest a test uses, which is a fixture detail leaking
   * into what the test is actually about.
   */
  readonly bundle?: {
    readonly origin: string;
    readonly bytes: Uint8Array;
  };
  /** When set, the list probe `inspect` makes is refused with this. */
  readonly refuseList?: { status: number; body: unknown };
  /** When set, creating a version is refused with this. */
  readonly refuseVersion?: { status: number; body: unknown };
  /**
   * When set, deleting a site at the real (project-scoped) path answers with
   * this instead of removing the site — the regression arrangement for a
   * destroy that must not report success it did not earn.
   */
  readonly refuseDelete?: { status: number; body: unknown };
  /** When set, adding a domain answers with this. */
  readonly domainAnswer?: { status: number; body: unknown };
  readonly token?: string;
}

/** One version the fake is holding, with what has been done to it. */
interface FakeVersion {
  name: string;
  site: string;
  status: string;
  labels: Record<string, string>;
  files: Record<string, string>;
}

const UPLOAD_BASE = 'https://upload.example.test/files';

/**
 * The most file hashes one `populateFiles` call may carry.
 *
 * The API's documented ceiling, modelled because it is the boundary every
 * real static site crosses and the one nothing here could previously reach.
 */
const POPULATE_LIMIT = 1000;

export class FakeHosting {
  readonly endpoint = CLOUD_ENDPOINTS.hosting;
  readonly requests: RecordedHostingRequest[] = [];

  private readonly sites = new Set<string>();
  private readonly versions = new Map<string, FakeVersion>();
  /** Site id → the version name currently released on it. */
  private readonly released = new Map<string, string>();
  /** Domains attached, by site — the assertion surface for §9's re-point. */
  private readonly domains = new Map<string, string[]>();
  private readonly held: Set<string>;
  private readonly uploaded = new Set<string>();
  private nextVersion = 1;

  constructor(private readonly options: FakeHostingOptions = {}) {
    for (const site of options.sites ?? []) this.sites.add(site);
    this.held = new Set(options.held ?? []);
  }

  get project(): string {
    return this.options.project ?? 'example-vessel';
  }

  /** Mint the token provider the adapter is constructed with. */
  token = (): string => this.options.token ?? 'federated-token';

  /** Whether a site exists — the assertion surface for `destroy`. */
  hasSite(site: string): boolean {
    return this.sites.has(site);
  }

  /** The version currently serving on one site, if any. */
  serving(site: string): FakeVersion | undefined {
    const name = this.released.get(site);
    return name === undefined ? undefined : this.versions.get(name);
  }

  /** The file paths the released version holds, sorted. */
  servedPaths(site: string): string[] {
    return Object.keys(this.serving(site)?.files ?? {}).sort();
  }

  /** Hashes actually uploaded — what proves the adapter honoured the answer. */
  get uploads(): string[] {
    return [...this.uploaded].sort();
  }

  /** Domains attached to one site (§9). */
  domainsOf(site: string): string[] {
    return [...(this.domains.get(site) ?? [])];
  }

  pathsOf(method: string): string[] {
    return this.requests
      .filter((request) => request.method === method)
      .map((request) => request.path);
  }

  fetch: Fetcher = async (request) => {
    const url = new URL(request.url);

    // The bundle is not part of the hosting API and carries no bearer token:
    // it is an artifact address, served here so the adapter's own fetch runs.
    const bundle = this.options.bundle;
    if (bundle !== undefined && url.origin === new URL(bundle.origin).origin) {
      return new Response(bundle.bytes as unknown as BodyInit);
    }

    if (url.href.startsWith(UPLOAD_BASE)) {
      const hash = url.pathname.split('/').pop() ?? '';
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      // The address a file is uploaded to *is* its hash, and the product
      // stores the compressed file: "The hash is calculated by Gzipping the
      // file then taking the SHA256 hash of the newly compressed file." An
      // adapter that hashed the file's own bytes, or that offered a gzip hash
      // and then uploaded the plain file, would be storing content under an
      // address that is not its content — so both halves are checked rather
      // than assumed correct because they happen to be today.
      if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return json(400, invalid('the uploaded file is not gzipped'));
      }
      const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      if (digest !== hash) {
        return json(
          400,
          invalid(`the uploaded bytes hash to ${digest}, not to ${hash}`),
        );
      }
      this.uploaded.add(hash);
      this.held.add(hash);
      return json(200, {});
    }

    const contentType = request.headers.get('content-type') ?? '';
    const body =
      request.method === 'GET' ||
      request.method === 'DELETE' ||
      !contentType.includes('json')
        ? null
        : await request.clone().json();
    this.requests.push({
      method: request.method,
      url: `${url.pathname}${url.search}`,
      path: url.pathname,
      body,
    });

    if (request.headers.get('authorization') !== `Bearer ${this.token()}`) {
      return json(401, { error: { message: 'unauthenticated' } });
    }

    return this.route(request.method, url, body);
  };

  private route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname.replace(/^\/v1beta1\//, '');

    if (path === `projects/${this.project}/sites`) {
      if (method === 'GET') {
        if (this.options.refuseList !== undefined) {
          return json(
            this.options.refuseList.status,
            this.options.refuseList.body,
          );
        }
        return json(200, { sites: [...this.sites].map((id) => site(id)) });
      }
      if (method === 'POST') {
        const id = url.searchParams.get('siteId') ?? '';
        if (id === '') return json(400, error('no siteId'));
        // Somebody else got there between the read and this call.
        if (this.options.appearsBeforeCreate === id && !this.sites.has(id)) {
          this.sites.add(id);
        }
        // Creating a site that exists is a 409, not a second create. A fake
        // that quietly succeeded here let a deploy-once adapter look
        // idempotent: nothing in the suite could tell "the site was already
        // there" from "the site was made", which is the whole difference
        // between a revision and a first deploy.
        if (this.sites.has(id)) {
          return json(409, {
            error: {
              code: 409,
              status: 'ALREADY_EXISTS',
              message: `Site \`projects/${this.project}/sites/${id}\` already exists.`,
            },
          });
        }
        this.sites.add(id);
        return json(200, site(id));
      }
    }

    // `projects.sites.delete` — the only path the real API serves for site
    // deletion. There is no flat `sites.delete`; the flat `sites/{id}` form
    // below answers reads only, so a DELETE aimed at it falls through to the
    // catch-all 404, same as the real API.
    const projectSiteMatch = path.match(
      new RegExp(`^projects/${this.project}/sites/([^/]+)$`),
    );
    // `projects.sites.get` — and the only form of it. Reading a site is
    // project-scoped for the same reason deleting one is.
    if (projectSiteMatch !== null && method === 'GET') {
      const id = projectSiteMatch[1] as string;
      return this.sites.has(id)
        ? json(200, site(id))
        : json(404, error('no site'));
    }
    if (projectSiteMatch !== null && method === 'DELETE') {
      const id = projectSiteMatch[1] as string;
      if (this.options.refuseDelete !== undefined) {
        return json(
          this.options.refuseDelete.status,
          this.options.refuseDelete.body,
        );
      }
      if (!this.sites.has(id)) return json(404, error('no site'));
      this.sites.delete(id);
      this.released.delete(id);
      this.domains.delete(id);
      return json(200, {});
    }

    const versionMatch = path.match(/^sites\/([^/]+)\/versions\/([^/:]+)$/);
    if (versionMatch !== null) {
      return this.finalize(
        method,
        url,
        versionMatch[1] as string,
        versionMatch[2] as string,
        body,
      );
    }

    const populateMatch = path.match(
      /^sites\/([^/]+)\/versions\/([^/:]+):populateFiles$/,
    );
    if (populateMatch !== null) {
      return this.populate(
        `sites/${populateMatch[1]}/versions/${populateMatch[2]}`,
        body,
      );
    }

    // No flat `sites/{id}` resource: the real API routes the sub-collections
    // below (`/versions`, `/releases`, `/domains`) under a bare site id, but
    // the site *itself* is only ever `projects/{project}/sites/{id}`. A GET
    // here falls through to the catch-all, which is what production does —
    // and a 404 from a path that was never a path reads exactly like a 404
    // from a site that is not there, which is how a deploy-once adapter
    // survived this suite.

    const versionsMatch = path.match(/^sites\/([^/]+)\/versions$/);
    if (versionsMatch !== null && method === 'POST') {
      return this.createVersion(versionsMatch[1] as string, body);
    }

    const releasesMatch = path.match(/^sites\/([^/]+)\/releases$/);
    if (releasesMatch !== null) {
      const id = releasesMatch[1] as string;
      if (method === 'GET') return this.readReleases(id);
      if (method === 'POST') return this.release(id, url);
    }

    const domainsMatch = path.match(/^sites\/([^/]+)\/domains$/);
    if (domainsMatch !== null && method === 'POST') {
      if (this.options.domainAnswer !== undefined) {
        return json(
          this.options.domainAnswer.status,
          this.options.domainAnswer.body,
        );
      }
      const id = domainsMatch[1] as string;
      const name = (body as { domainName?: string })?.domainName ?? '';
      this.domains.set(id, [...(this.domains.get(id) ?? []), name]);
      return json(200, { site: id, domainName: name });
    }

    return json(404, error('no such path'));
  }

  private createVersion(site: string, body: unknown): Response {
    if (this.options.refuseVersion !== undefined) {
      return json(
        this.options.refuseVersion.status,
        this.options.refuseVersion.body,
      );
    }
    if (!this.sites.has(site)) return json(404, error('no site'));
    const name = `sites/${site}/versions/v${this.nextVersion++}`;
    this.versions.set(name, {
      name,
      site,
      status: 'CREATED',
      labels: (body as { labels?: Record<string, string> })?.labels ?? {},
      files: {},
    });
    return json(200, { name, status: 'CREATED' });
  }

  private populate(name: string, body: unknown): Response {
    const version = this.versions.get(name);
    if (version === undefined) return json(404, error('no version'));
    const files = (body as { files?: Record<string, string> })?.files ?? {};
    // "You can send a maximum of 1000 file hashes in each API request." A
    // built site clears that on its first deploy, so an adapter that offers
    // the whole map in one call fails here rather than only in production.
    if (Object.keys(files).length > POPULATE_LIMIT) {
      return json(
        400,
        invalid(
          `a maximum of ${POPULATE_LIMIT} file hashes may be sent in each request`,
        ),
      );
    }
    // "The files in each call will be added to the version" — the calls
    // accumulate. A fake that replaced would make a chunked offer look like it
    // had populated only its last chunk.
    version.files = { ...version.files, ...files };
    // Only the hashes not already held are asked for, which is the behaviour
    // the adapter's upload loop is written against.
    const wanted = [...new Set(Object.values(files))].filter(
      (hash) => !this.held.has(hash),
    );
    return json(200, {
      uploadRequiredHashes: wanted,
      uploadUrl: UPLOAD_BASE,
    });
  }

  private finalize(
    method: string,
    url: URL,
    site: string,
    id: string,
    body: unknown,
  ): Response {
    const name = `sites/${site}/versions/${id}`;
    const version = this.versions.get(name);
    if (version === undefined) return json(404, error('no version'));
    if (method !== 'PATCH') return json(405, error('not supported'));
    if (url.searchParams.get('updateMask') !== 'status') {
      return json(400, error('only status may be patched'));
    }
    version.status = (body as { status?: string })?.status ?? version.status;
    return json(200, { name, status: version.status });
  }

  private release(site: string, url: URL): Response {
    const name = url.searchParams.get('versionName') ?? '';
    const version = this.versions.get(name);
    if (version === undefined) return json(404, error('no version'));
    // The product will not serve a draft, so neither will the fake.
    if (version.status !== 'FINALIZED') {
      return json(400, error(`version ${name} is ${version.status}`));
    }
    this.released.set(site, name);
    return json(200, {
      name: `sites/${site}/releases/r1`,
      version: { name, status: version.status, labels: version.labels },
    });
  }

  private readReleases(site: string): Response {
    if (!this.sites.has(site)) return json(404, error('no site'));
    const name = this.released.get(site);
    const version = name === undefined ? undefined : this.versions.get(name);
    return json(200, {
      releases:
        version === undefined
          ? []
          : [
              {
                name: `sites/${site}/releases/r1`,
                version: {
                  name: version.name,
                  status: version.status,
                  labels: version.labels,
                },
              },
            ],
    });
  }
}

function site(id: string): unknown {
  return {
    name: `sites/${id}`,
    defaultUrl: `https://${id}.hosted.example.test`,
  };
}

function error(message: string): unknown {
  return { error: { message, status: 'NOT_FOUND' } };
}

/** A refusal because the request itself was malformed, not because of state. */
function invalid(message: string): unknown {
  return { error: { message, status: 'INVALID_ARGUMENT' } };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
