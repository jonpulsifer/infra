/**
 * The Firebase Hosting API behind the real adapter. `populateFiles` asks only
 * for hashes it lacks, and a release takes only a finalized version.
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
  readonly sites?: readonly string[];
  /** Appears between the adapter's read and its create, which then gets 409. */
  readonly appearsBeforeCreate?: string;
  /**
   * Ids in no visible project: a deleted site's id is reserved forever, so the
   * create gets 409 and the read-back finds nothing.
   */
  readonly reserved?: readonly string[];
  /** Hashes already held, which `populateFiles` does not ask for. */
  readonly held?: readonly string[];
  /** An artifact origin that serves `bytes` at every address. */
  readonly bundle?: {
    readonly origin: string;
    readonly bytes: Uint8Array;
  };
  /** When set, listing sites answers with this. */
  readonly refuseList?: { status: number; body: unknown };
  readonly refuseVersion?: { status: number; body: unknown };
  /** When set, deleting a site answers with this and keeps the site. */
  readonly refuseDelete?: { status: number; body: unknown };
  /** When set, adding a domain answers with this. */
  readonly domainAnswer?: { status: number; body: unknown };
  readonly token?: string;
}

interface FakeVersion {
  name: string;
  site: string;
  status: string;
  labels: Record<string, string>;
  files: Record<string, string>;
}

const UPLOAD_BASE = 'https://upload.example.test/files';

/** The documented maximum of file hashes per `populateFiles` call. */
const POPULATE_LIMIT = 1000;

export class FakeHosting {
  readonly endpoint = CLOUD_ENDPOINTS.hosting;
  readonly requests: RecordedHostingRequest[] = [];

  private readonly sites = new Set<string>();
  private readonly versions = new Map<string, FakeVersion>();
  /** Each site's released version name. */
  private readonly released = new Map<string, string>();
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

  /** The adapter's token provider. */
  token = (): string => this.options.token ?? 'federated-token';

  hasSite(site: string): boolean {
    return this.sites.has(site);
  }

  get siteCount(): number {
    return this.sites.size;
  }

  serving(site: string): FakeVersion | undefined {
    const name = this.released.get(site);
    return name === undefined ? undefined : this.versions.get(name);
  }

  servedPaths(site: string): string[] {
    return Object.keys(this.serving(site)?.files ?? {}).sort();
  }

  get uploads(): string[] {
    return [...this.uploaded].sort();
  }

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

    // The bundle is an artifact address outside the hosting API, with no token.
    const bundle = this.options.bundle;
    if (bundle !== undefined && url.origin === new URL(bundle.origin).origin) {
      return new Response(bundle.bytes as unknown as BodyInit);
    }

    if (url.href.startsWith(UPLOAD_BASE)) {
      const hash = url.pathname.split('/').pop() ?? '';
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      // The upload address is the SHA-256 of the gzipped file, so both the gzip
      // and the hash are checked.
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
        if (this.options.appearsBeforeCreate === id && !this.sites.has(id)) {
          this.sites.add(id);
        }
        // An existing or reserved id answers 409, as the real API does.
        if (this.sites.has(id) || this.options.reserved?.includes(id)) {
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

    // A site itself is only `projects/{project}/sites/{id}`; the flat
    // `sites/{id}` form holds sub-collections, and anything else there 404s.
    const projectSiteMatch = path.match(
      new RegExp(`^projects/${this.project}/sites/([^/]+)$`),
    );
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
    if (Object.keys(files).length > POPULATE_LIMIT) {
      return json(
        400,
        invalid(
          `a maximum of ${POPULATE_LIMIT} file hashes may be sent in each request`,
        ),
      );
    }
    // Calls accumulate into the version, as documented.
    version.files = { ...version.files, ...files };
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

function invalid(message: string): unknown {
  return { error: { message, status: 'INVALID_ARGUMENT' } };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
