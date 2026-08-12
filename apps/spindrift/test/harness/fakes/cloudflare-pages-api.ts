/**
 * A fake edge static-hosting API (§ Seam 2).
 *
 * "A fake of the far-side HTTP API behind the real client, with the test
 * asserting the requests that were made" — so the adapter's real project
 * ensure, its real hashing, its real bucket packing and its real bundle reading
 * all run.
 *
 * Four behaviours are modelled because the adapter depends on all four, and
 * each one is a way a plausible adapter could be wrong:
 *
 * - **The asset store accepts only the minted token.** The account credential is
 *   refused there, and the minted one is refused everywhere else. An adapter
 *   that used one client for both would pass a fake that checked neither and
 *   `401` on every file in production.
 * - **`check-missing` answers only what it does not hold**, which is what makes
 *   redeploying an unchanged site cheap. A fake that always asked for
 *   everything would let an adapter that ignored the answer pass.
 * - **A deployment's manifest may only name hashes the store holds.** This is
 *   the invariant the whole upload exists to satisfy: a manifest naming a hash
 *   nobody uploaded finalizes happily and serves a broken site, so it is
 *   refused here rather than discovered by a person.
 * - **The bundle is served from wherever the artifact says it is**, over the
 *   same injected transport, because the adapter fetching its own artifact is a
 *   real step a fake API alone would leave untested.
 */
import type { Fetcher } from '../../../src/adapters/deploy/cloud/http.ts';
import { CLOUDFLARE_ENDPOINT } from '../installation.ts';

export interface RecordedCloudflareRequest {
  method: string;
  url: string;
  path: string;
  body: unknown;
}

export interface FakeCloudflarePagesOptions {
  readonly account?: string;
  /** Projects that already exist, by name. */
  readonly projects?: readonly string[];
  /**
   * A project that appears between the adapter's read and its create.
   *
   * The create race: two deploys of a new App, or a retry after a timeout that
   * did land. The read says missing, the create says conflict, and the desired
   * state is true either way — so this exists to prove the adapter treats it
   * that way rather than failing on a project it wanted.
   */
  readonly appearsBeforeCreate?: string;
  /** Hashes the store already holds, so it will not ask for them again. */
  readonly held?: readonly string[];
  /** The artifact depot, and the bundle every address under it serves. */
  readonly bundle?: {
    readonly origin: string;
    readonly bytes: Uint8Array;
  };
  /** When set, the list probe `inspect` makes is refused with this. */
  readonly refuseList?: { status: number; body?: unknown };
  /** When set, minting an upload token is refused with this. */
  readonly refuseToken?: { status: number; body?: unknown };
  /** When set, creating a deployment is refused with this. */
  readonly refuseDeployment?: { status: number; body?: unknown };
  /**
   * When set, deleting a project answers with this instead of removing it —
   * the arrangement for a destroy that must not report success it did not earn.
   */
  readonly refuseDelete?: { status: number; body?: unknown };
  /** When set, adding a domain answers with this. */
  readonly domainAnswer?: { status: number; body?: unknown };
  readonly token?: string;
  /** The production branch an already-existing project carries. */
  readonly productionBranch?: string;
}

/** One deployment the fake is holding. */
interface FakeDeployment {
  id: string;
  project: string;
  branch: string;
  commitMessage: string;
  manifest: Record<string, string>;
  stage: { name: string; status: string };
}

/** What `upload-token` mints. Opaque to the adapter, checked by the store. */
const UPLOAD_TOKEN = 'minted-upload-token';

export class FakeCloudflarePages {
  readonly endpoint = CLOUDFLARE_ENDPOINT;
  readonly requests: RecordedCloudflareRequest[] = [];

  private readonly projects = new Set<string>();
  /** Project → its deployments, newest first. */
  private readonly deployments = new Map<string, FakeDeployment[]>();
  /** Domains attached, by project — the assertion surface for §9's re-point. */
  private readonly domains = new Map<string, string[]>();
  private readonly held: Set<string>;
  private readonly uploaded = new Set<string>();
  private nextDeployment = 1;

  constructor(private readonly options: FakeCloudflarePagesOptions = {}) {
    for (const project of options.projects ?? []) this.projects.add(project);
    this.held = new Set(options.held ?? []);
  }

  get account(): string {
    return this.options.account ?? 'example-account';
  }

  /** Mint the token provider the adapter is constructed with. */
  token = (): string => this.options.token ?? 'account-credential';

  /** Whether a project exists — the assertion surface for `destroy`. */
  hasProject(project: string): boolean {
    return this.projects.has(project);
  }

  /** The deployment currently serving on one project, if any. */
  serving(project: string): FakeDeployment | undefined {
    return this.deployments.get(project)?.[0];
  }

  /** The file paths the latest deployment serves, sorted. */
  servedPaths(project: string): string[] {
    return Object.keys(this.serving(project)?.manifest ?? {}).sort();
  }

  /** Hashes actually uploaded — what proves the adapter honoured the answer. */
  get uploads(): string[] {
    return [...this.uploaded].sort();
  }

  /** Domains attached to one project (§9). */
  domainsOf(project: string): string[] {
    return [...(this.domains.get(project) ?? [])];
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

    const contentType = request.headers.get('content-type') ?? '';
    const multipart = contentType.includes('multipart/form-data');
    const body = multipart
      ? await request.clone().formData()
      : request.method === 'GET' ||
          request.method === 'DELETE' ||
          !contentType.includes('json')
        ? null
        : await request.clone().json();

    this.requests.push({
      method: request.method,
      url: `${url.pathname}${url.search}`,
      path: url.pathname,
      body: multipart ? '<form>' : body,
    });

    const authorization = request.headers.get('authorization');
    const store = url.pathname.startsWith('/pages/assets/');
    // The two credentials are not interchangeable, and neither is accepted
    // where the other belongs — see the file header.
    const expected = store ? UPLOAD_TOKEN : this.token();
    if (authorization !== `Bearer ${expected}`) {
      return envelope(401, null, [
        {
          code: 10000,
          message: store
            ? 'the asset store takes the minted upload token'
            : 'Authentication error',
        },
      ]);
    }

    return this.route(request.method, url, body);
  };

  private route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    const base = `/accounts/${this.account}/pages/projects`;

    if (path === '/pages/assets/check-missing' && method === 'POST') {
      const offered = (body as { hashes?: string[] })?.hashes ?? [];
      return envelope(
        200,
        offered.filter((hash) => !this.held.has(hash)),
      );
    }
    if (path === '/pages/assets/upload' && method === 'POST') {
      return this.upload(body);
    }
    if (path === '/pages/assets/upsert-hashes' && method === 'POST') {
      return envelope(200, null);
    }

    if (path === base) {
      if (method === 'GET') {
        if (this.options.refuseList !== undefined) {
          return envelope(
            this.options.refuseList.status,
            this.options.refuseList.body ?? null,
          );
        }
        return envelope(
          200,
          [...this.projects].map((name) => this.project(name)),
        );
      }
      if (method === 'POST') {
        const name = (body as { name?: string })?.name ?? '';
        if (name === '') return envelope(400, null, [{ message: 'no name' }]);
        // Somebody else got there between the read and this call.
        if (this.options.appearsBeforeCreate === name) {
          this.projects.add(name);
        }
        // Creating a project that exists is a conflict, not a second create. A
        // fake that quietly succeeded here would let a deploy-once adapter look
        // idempotent.
        if (this.projects.has(name)) {
          return envelope(409, null, [
            {
              code: 8000007,
              message: `A project with the name ${name} exists`,
            },
          ]);
        }
        this.projects.add(name);
        return envelope(200, this.project(name));
      }
    }

    const projectMatch = path.match(
      new RegExp(`^${quoted(base)}/([^/]+)(/[^/]+)?$`),
    );
    if (projectMatch === null) {
      return envelope(404, null, [{ message: 'no such path' }]);
    }
    const project = projectMatch[1] as string;
    const sub = projectMatch[2] ?? '';

    if (sub === '' && method === 'GET') {
      return this.projects.has(project)
        ? envelope(200, this.project(project))
        : envelope(404, null, [{ code: 8000007, message: 'no project' }]);
    }
    if (sub === '' && method === 'DELETE') {
      if (this.options.refuseDelete !== undefined) {
        return envelope(
          this.options.refuseDelete.status,
          this.options.refuseDelete.body ?? null,
        );
      }
      if (!this.projects.has(project)) {
        return envelope(404, null, [{ message: 'no project' }]);
      }
      this.projects.delete(project);
      this.deployments.delete(project);
      this.domains.delete(project);
      return envelope(200, null);
    }

    if (sub === '/upload-token' && method === 'GET') {
      if (this.options.refuseToken !== undefined) {
        return envelope(
          this.options.refuseToken.status,
          this.options.refuseToken.body ?? null,
        );
      }
      if (!this.projects.has(project)) {
        return envelope(404, null, [{ message: 'no project' }]);
      }
      return envelope(200, { jwt: UPLOAD_TOKEN });
    }

    if (sub === '/deployments') {
      if (method === 'GET') {
        // Rendered through the same shape a create answers with. Handing back
        // the internal row would let an adapter that read a field the real API
        // does not have pass here and find nothing in production.
        const page = Number(url.searchParams.get('per_page') ?? '0');
        const all = (this.deployments.get(project) ?? []).map((deployment) =>
          this.asDeployment(deployment),
        );
        return envelope(200, page > 0 ? all.slice(0, page) : all);
      }
      if (method === 'POST') return this.deploy(project, body);
    }

    if (sub === '/domains' && method === 'POST') {
      if (this.options.domainAnswer !== undefined) {
        return envelope(
          this.options.domainAnswer.status,
          this.options.domainAnswer.body ?? null,
        );
      }
      const name = (body as { name?: string })?.name ?? '';
      this.domains.set(project, [...(this.domains.get(project) ?? []), name]);
      return envelope(200, { name });
    }

    return envelope(404, null, [{ message: 'no such path' }]);
  }

  /**
   * Accept a bucket of files.
   *
   * The key is checked for shape rather than recomputed: the payload carries no
   * file name, so the extension the real formula folds in is not here to fold.
   * That half is pinned by a fixed vector in `test/adapters/pages.test.ts`,
   * where it can be checked against the vendor's own algorithm with no far side
   * at all.
   */
  private upload(body: unknown): Response {
    const files = Array.isArray(body) ? body : [];
    for (const file of files) {
      const { key, value, base64 } = file as {
        key?: string;
        value?: string;
        base64?: boolean;
      };
      if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) {
        return envelope(400, null, [
          { message: `key ${String(key)} is not a 32-character hex digest` },
        ]);
      }
      if (base64 !== true || typeof value !== 'string') {
        return envelope(400, null, [
          { message: 'a file is uploaded as base64 text' },
        ]);
      }
      this.uploaded.add(key);
      this.held.add(key);
    }
    return envelope(200, null);
  }

  private deploy(project: string, body: unknown): Response {
    if (this.options.refuseDeployment !== undefined) {
      return envelope(
        this.options.refuseDeployment.status,
        this.options.refuseDeployment.body ?? null,
      );
    }
    if (!this.projects.has(project)) {
      return envelope(404, null, [{ message: 'no project' }]);
    }
    if (!(body instanceof FormData)) {
      return envelope(400, null, [{ message: 'a deployment is a form' }]);
    }
    const manifest = JSON.parse(String(body.get('manifest') ?? '{}')) as Record<
      string,
      string
    >;
    // The invariant the whole upload exists to satisfy — see the file header.
    const absent = Object.entries(manifest)
      .filter(([, hash]) => !this.held.has(hash))
      .map(([path]) => path);
    if (absent.length > 0) {
      return envelope(400, null, [
        {
          code: 8000000,
          message: `the manifest names files the store does not hold: ${absent.sort().join(', ')}`,
        },
      ]);
    }

    const deployment: FakeDeployment = {
      id: `deployment-${this.nextDeployment++}`,
      project,
      branch: String(body.get('branch') ?? ''),
      commitMessage: String(body.get('commit_message') ?? ''),
      manifest,
      stage: { name: 'deploy', status: 'success' },
    };
    this.deployments.set(project, [
      deployment,
      ...(this.deployments.get(project) ?? []),
    ]);
    return envelope(200, this.asDeployment(deployment));
  }

  private project(name: string): unknown {
    return {
      name,
      subdomain: `${name}.pages.example.test`,
      production_branch: this.options.productionBranch ?? 'production',
    };
  }

  private asDeployment(deployment: FakeDeployment): unknown {
    return {
      id: deployment.id,
      url: `https://${deployment.id}.${deployment.project}.pages.example.test`,
      latest_stage: deployment.stage,
      deployment_trigger: {
        metadata: { commit_message: deployment.commitMessage },
      },
    };
  }
}

/** Every answer is enveloped, success included — see `pages/assets.ts`. */
function envelope(
  status: number,
  result: unknown,
  errors: readonly { code?: number; message?: string }[] = [],
): Response {
  return new Response(
    JSON.stringify({
      success: errors.length === 0,
      errors,
      messages: [],
      result,
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function quoted(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
