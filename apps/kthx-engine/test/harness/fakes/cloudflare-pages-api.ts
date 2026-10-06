/**
 * The Cloudflare Pages API behind the real adapter. The asset store takes only
 * the minted upload token, `check-missing` asks only for hashes it lacks, and a
 * deployment manifest may name only hashes the store holds.
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
  readonly projects?: readonly string[];
  /** Appears between the adapter's read and its create, which then gets 409. */
  readonly appearsBeforeCreate?: string;
  /** Hashes the store already holds, which `check-missing` leaves out. */
  readonly held?: readonly string[];
  /** An artifact origin that serves `bytes` at every address. */
  readonly bundle?: {
    readonly origin: string;
    readonly bytes: Uint8Array;
  };
  /** When set, listing projects answers with this. */
  readonly refuseList?: { status: number; body?: unknown };
  readonly refuseToken?: { status: number; body?: unknown };
  readonly refuseDeployment?: { status: number; body?: unknown };
  /** When set, deleting a project answers with this and keeps the project. */
  readonly refuseDelete?: { status: number; body?: unknown };
  /** When set, adding a domain answers with this. */
  readonly domainAnswer?: { status: number; body?: unknown };
  /**
   * An added domain's status: Cloudflare reports `initializing` until the
   * certificate issues, then `active`; `blocked` and `error` are terminal.
   */
  readonly domainStatus?: string;
  /** Domains on each project before the adapter runs, by project. */
  readonly domainsAlready?: Readonly<Record<string, readonly string[]>>;
  readonly token?: string;
  /** The `production_branch` every project reports. */
  readonly productionBranch?: string;
  /** Every created deployment's stage; defaults to a successful deploy. */
  readonly stage?: { readonly name: string; readonly status: string };
}

interface FakeDeployment {
  id: string;
  project: string;
  branch: string;
  commitMessage: string;
  manifest: Record<string, string>;
  stage: { name: string; status: string };
}

/** What `upload-token` mints and the asset store requires. */
const UPLOAD_TOKEN = 'minted-upload-token';

export class FakeCloudflarePages {
  readonly endpoint = CLOUDFLARE_ENDPOINT;
  readonly requests: RecordedCloudflareRequest[] = [];

  private readonly projects = new Set<string>();
  /** Each project's deployments, newest first. */
  private readonly deployments = new Map<string, FakeDeployment[]>();
  /** Project to domain name to status. */
  private readonly domains = new Map<string, Map<string, string>>();
  private readonly held: Set<string>;
  private readonly uploaded = new Set<string>();
  private nextDeployment = 1;

  constructor(private readonly options: FakeCloudflarePagesOptions = {}) {
    for (const project of options.projects ?? []) this.projects.add(project);
    this.held = new Set(options.held ?? []);
    for (const [project, names] of Object.entries(
      options.domainsAlready ?? {},
    )) {
      this.domains.set(
        project,
        new Map(names.map((name) => [name, options.domainStatus ?? 'active'])),
      );
    }
  }

  get account(): string {
    return this.options.account ?? 'example-account';
  }

  /** The adapter's token provider, which yields the account credential. */
  token = (): string => this.options.token ?? 'account-credential';

  hasProject(project: string): boolean {
    return this.projects.has(project);
  }

  serving(project: string): FakeDeployment | undefined {
    return this.deployments.get(project)?.[0];
  }

  servedPaths(project: string): string[] {
    return Object.keys(this.serving(project)?.manifest ?? {}).sort();
  }

  get uploads(): string[] {
    return [...this.uploaded].sort();
  }

  get deploymentCount(): number {
    return [...this.deployments.values()].reduce(
      (count, held) => count + held.length,
      0,
    );
  }

  domainsOf(project: string): string[] {
    return [...(this.domains.get(project)?.keys() ?? [])];
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
    // Each credential is refused where the other belongs.
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
        if (this.options.appearsBeforeCreate === name) {
          this.projects.add(name);
        }
        // An existing name answers 409, as the real API does.
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

    // Up to two segments, so `/domains/{name}` reaches its handler.
    const projectMatch = path.match(
      new RegExp(`^${quoted(base)}/([^/]+)((?:/[^/]+){0,2})$`),
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
        // The create answer's shape, so a field the real API lacks is absent.
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
      const status = this.options.domainStatus ?? 'active';
      const onProject = this.domains.get(project) ?? new Map<string, string>();
      onProject.set(name, status);
      this.domains.set(project, onProject);
      return envelope(200, { name, status });
    }

    // The adapter reads a domain back to learn whether a refused POST means it
    // is already attached.
    if (sub.startsWith('/domains/') && method === 'GET') {
      const name = decodeURIComponent(sub.slice('/domains/'.length));
      const status = this.domains.get(project)?.get(name);
      return status === undefined
        ? envelope(404, null, [{ message: 'no such domain' }])
        : envelope(200, { name, status });
    }

    return envelope(404, null, [{ message: 'no such path' }]);
  }

  /**
   * Checks each key's shape only: the real formula folds in the file extension,
   * which the payload lacks. `test/adapters/pages.test.ts` pins the formula.
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
    // A manifest naming an unheld hash would finalize and serve a broken site.
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
      stage: this.options.stage ?? { name: 'deploy', status: 'success' },
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

/** Every answer is enveloped, success included. */
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
