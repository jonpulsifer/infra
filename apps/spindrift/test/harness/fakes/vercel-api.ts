/**
 * A fake Vercel API (§ Seam 2).
 *
 * "A fake of the far-side HTTP API behind the real client, with the test
 * asserting the requests that were made" — so the adapter's real upload loop,
 * its real SHA-1 addressing, and its real bundle reading all run.
 *
 * Four behaviours are modelled, because the adapter depends on all four:
 *
 * - **A deployment does not arrive ready.** It reports `QUEUED`, then
 *   `BUILDING`, then whatever it settles on, so an adapter that returned on the
 *   create response would report `LIVE` for a deployment that is still queuing.
 * - **A file is referenced by the SHA-1 of its own bytes.** The upload checks
 *   the digest header against what was sent, so an adapter that offered one hash
 *   and uploaded other bytes fails here rather than in production.
 * - **A deployment may only reference files that were uploaded**, which is what
 *   makes the upload step a step rather than a formality.
 * - **The bundle is served from wherever the artifact says it is**, over the
 *   same injected transport, because the adapter fetching its own artifact is a
 *   real step a fake API alone would leave untested.
 */
import type { Fetcher } from '../../../src/adapters/deploy/cloud/http.ts';
import { VERCEL_ENDPOINT } from '../installation.ts';

export interface RecordedVercelRequest {
  method: string;
  url: string;
  path: string;
  body: unknown;
}

export interface FakeVercelOptions {
  readonly team?: string;
  /** Projects that already exist, by name. */
  readonly projects?: readonly string[];
  /**
   * What every created deployment settles on, after queuing and building.
   *
   * `READY` is the ordinary case. `ERROR` is what a real build failure looks
   * like from here, and it is a state rather than a refusal — the create
   * succeeded and the deployment went red, which is the distinction §6's
   * verdict has to preserve.
   */
  readonly settlesOn?: 'READY' | 'ERROR' | 'CANCELED';
  /** How many polls a deployment spends short of its terminal state. */
  readonly pollsBeforeSettling?: number;
  /** When set, the project list `inspect` makes is refused with this. */
  readonly refuseList?: { status: number; body: unknown };
  /** When set, creating a deployment is refused with this. */
  readonly refuseCreate?: { status: number; body: unknown };
  /** When set, deleting a project answers with this instead of removing it. */
  readonly refuseDelete?: { status: number; body: unknown };
  /** When set, adding a domain answers with this. */
  readonly domainAnswer?: { status: number; body: unknown };
  /** See `FakeHosting.bundle` — matched by origin, for the same reason. */
  readonly bundle?: {
    readonly origin: string;
    readonly bytes: Uint8Array;
  };
  readonly token?: string;
}

/** One deployment the fake is holding. */
interface FakeDeployment {
  id: string;
  project: string;
  url: string;
  meta: Record<string, string>;
  files: string[];
  /**
   * Whether this deployment was created as prebuilt.
   *
   * On the query rather than the body, which is where the real API takes it —
   * so a fake that read it from the body would let an adapter that never sent
   * it pass.
   */
  prebuilt: boolean;
  /** Polls remaining before it reaches {@link FakeVercelOptions.settlesOn}. */
  pending: number;
}

export class FakeVercel {
  readonly endpoint = VERCEL_ENDPOINT;
  readonly requests: RecordedVercelRequest[] = [];

  private readonly projects = new Set<string>();
  private readonly deployments = new Map<string, FakeDeployment>();
  /** Project name → the deployment currently serving production. */
  private readonly production = new Map<string, string>();
  /** Domains attached, by project — the assertion surface for §9's re-point. */
  private readonly domains = new Map<string, string[]>();
  private readonly uploaded = new Set<string>();
  /**
   * Environment variables per project, in insertion order.
   *
   * The platform's own constraint modelled rather than assumed: one variable
   * per `key` per target, so a create whose key is already there is refused —
   * which is what makes `put`'s delete-then-create the only thing that works.
   */
  private readonly env = new Map<
    string,
    {
      id: string;
      key: string;
      value: string;
      type: string;
      createdAt: number;
    }[]
  >();
  private next = 1;

  constructor(private readonly options: FakeVercelOptions = {}) {
    for (const project of options.projects ?? []) this.projects.add(project);
  }

  get team(): string {
    return this.options.team ?? 'example-team';
  }

  /** Mint the token provider the adapter is constructed with. */
  token = (): string => this.options.token ?? 'vercel-token';

  /** Whether a project exists — the assertion surface for `destroy`. */
  hasProject(project: string): boolean {
    return this.projects.has(project);
  }

  /** The deployment currently serving production on one project, if any. */
  serving(project: string): FakeDeployment | undefined {
    const id = this.production.get(project);
    return id === undefined ? undefined : this.deployments.get(id);
  }

  /** The file paths the serving deployment holds, sorted. */
  servedPaths(project: string): string[] {
    return [...(this.serving(project)?.files ?? [])].sort();
  }

  /** Whether the serving deployment was created as a prebuilt one. */
  servedPrebuilt(project: string): boolean {
    return this.serving(project)?.prebuilt ?? false;
  }

  /** The environment variables one project holds, for a test to assert on. */
  environment(project: string): { key: string; type: string }[] {
    return (this.env.get(project) ?? []).map(({ key, type }) => ({
      key,
      type,
    }));
  }

  /** Digests actually uploaded — what proves the upload step ran. */
  get uploads(): string[] {
    return [...this.uploaded].sort();
  }

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

    // The bundle is not part of the platform's API and carries no bearer: it is
    // an artifact address, served here so the adapter's own fetch runs.
    const bundle = this.options.bundle;
    if (bundle !== undefined && url.origin === new URL(bundle.origin).origin) {
      return new Response(bundle.bytes as unknown as BodyInit);
    }

    const contentType = request.headers.get('content-type') ?? '';
    const isJson = contentType.includes('json');
    const body =
      request.method === 'GET' || request.method === 'DELETE' || !isJson
        ? null
        : await request.clone().json();
    this.requests.push({
      method: request.method,
      url: `${url.pathname}${url.search}`,
      path: url.pathname,
      body,
    });

    if (request.headers.get('authorization') !== `Bearer ${this.token()}`) {
      return json(403, {
        error: { code: 'forbidden', message: 'not this token' },
      });
    }

    if (url.pathname === '/v2/files') {
      return this.upload(request);
    }
    return this.route(request.method, url, body);
  };

  private async upload(request: Request): Promise<Response> {
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    const digest = new Bun.CryptoHasher('sha1').update(bytes).digest('hex');
    const claimed = request.headers.get('x-vercel-digest');
    // The platform checks the digest against the bytes, so the fake does too:
    // an adapter that referenced one hash and uploaded another would otherwise
    // create a deployment whose files are not its files.
    if (claimed !== digest) {
      return json(400, {
        error: {
          code: 'invalid_digest',
          message: `the uploaded bytes hash to ${digest}, not to ${claimed}`,
        },
      });
    }
    this.uploaded.add(digest);
    return json(200, { urls: [] });
  }

  private route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;

    if (path === '/v9/projects' && method === 'GET') {
      if (this.options.refuseList !== undefined) {
        return json(
          this.options.refuseList.status,
          this.options.refuseList.body,
        );
      }
      if (url.searchParams.get('teamId') !== this.team) {
        return json(404, notFound('no such team'));
      }
      return json(200, {
        projects: [...this.projects].map((name) => ({ id: name, name })),
      });
    }

    if (path === '/v13/deployments' && method === 'POST') {
      return this.create(body, url);
    }

    const deploymentMatch = path.match(/^\/v13\/deployments\/([^/]+)$/);
    if (deploymentMatch !== null && method === 'GET') {
      return this.read(deploymentMatch[1] as string);
    }

    if (path === '/v7/deployments' && method === 'GET') {
      return this.list(url);
    }

    const envList = path.match(/^\/v9\/projects\/([^/]+)\/env$/);
    if (envList !== null && method === 'GET') {
      const project = decodeURIComponent(envList[1] as string);
      if (!this.projects.has(project)) return json(404, notFound('no project'));
      return json(200, { envs: this.env.get(project) ?? [] });
    }

    const envCreate = path.match(/^\/v10\/projects\/([^/]+)\/env$/);
    if (envCreate !== null && method === 'POST') {
      const project = decodeURIComponent(envCreate[1] as string);
      if (!this.projects.has(project)) return json(404, notFound('no project'));
      const input = body as { key?: string; value?: string; type?: string };
      const held = this.env.get(project) ?? [];
      // The platform's own refusal, which is the whole reason a put deletes
      // first: an existing key is a `403`, not an overwrite.
      if (held.some((one) => one.key === input.key)) {
        return json(403, {
          error: {
            code: 'ENV_ALREADY_EXISTS',
            message: `${input.key} already exists`,
          },
        });
      }
      const created = {
        id: `env_${this.next++}`,
        key: input.key ?? '',
        value: input.value ?? '',
        type: input.type ?? 'plain',
        createdAt: this.next,
      };
      this.env.set(project, [...held, created]);
      return json(201, { created, failed: [] });
    }

    const envDelete = path.match(/^\/v9\/projects\/([^/]+)\/env\/([^/]+)$/);
    if (envDelete !== null && method === 'DELETE') {
      const project = decodeURIComponent(envDelete[1] as string);
      const id = decodeURIComponent(envDelete[2] as string);
      const held = this.env.get(project) ?? [];
      if (!held.some((one) => one.id === id)) {
        return json(404, notFound('no such environment variable'));
      }
      this.env.set(
        project,
        held.filter((one) => one.id !== id),
      );
      return json(200, {});
    }

    const projectRead = path.match(/^\/v9\/projects\/([^/]+)$/);
    if (projectRead !== null && method === 'GET') {
      const project = decodeURIComponent(projectRead[1] as string);
      if (!this.projects.has(project)) return json(404, notFound('no project'));
      return json(200, { id: project, name: project });
    }

    if (path === '/v9/projects' && method === 'POST') {
      const name = (body as { name?: string }).name ?? '';
      this.projects.add(name);
      return json(200, { id: name, name });
    }

    const projectMatch = path.match(/^\/v9\/projects\/([^/]+)$/);
    if (projectMatch !== null && method === 'DELETE') {
      const project = projectMatch[1] as string;
      if (this.options.refuseDelete !== undefined) {
        return json(
          this.options.refuseDelete.status,
          this.options.refuseDelete.body,
        );
      }
      if (!this.projects.has(project)) return json(404, notFound('no project'));
      this.projects.delete(project);
      this.production.delete(project);
      this.domains.delete(project);
      return new Response(null, { status: 204 });
    }

    const domainMatch = path.match(
      /^\/v9\/projects\/([^/]+)\/domains\/([^/]+)$/,
    );
    if (domainMatch !== null && method === 'GET') {
      const attached = this.domains.get(domainMatch[1] as string) ?? [];
      return attached.includes(domainMatch[2] as string)
        ? json(200, { name: domainMatch[2], verified: true })
        : json(404, notFound('no such domain on this project'));
    }

    const domainsMatch = path.match(/^\/v10\/projects\/([^/]+)\/domains$/);
    if (domainsMatch !== null && method === 'POST') {
      if (this.options.domainAnswer !== undefined) {
        return json(
          this.options.domainAnswer.status,
          this.options.domainAnswer.body,
        );
      }
      const project = domainsMatch[1] as string;
      const name = (body as { name?: string })?.name ?? '';
      this.domains.set(project, [...(this.domains.get(project) ?? []), name]);
      return json(200, {
        name,
        apexName: name,
        projectId: project,
        verified: true,
      });
    }

    return json(404, notFound('no such path'));
  }

  private create(body: unknown, url: URL): Response {
    if (this.options.refuseCreate !== undefined) {
      return json(
        this.options.refuseCreate.status,
        this.options.refuseCreate.body,
      );
    }
    const input = body as {
      name?: string;
      files?: { file: string; sha: string; size: number }[];
      meta?: Record<string, string>;
    };
    const project = input.name ?? '';
    if (project === '') return json(400, notFound('a deployment needs a name'));

    const files = input.files ?? [];
    // Every referenced file must have been uploaded first: that ordering is the
    // platform's contract, and an adapter that skipped the upload would
    // otherwise create a deployment the platform could never serve.
    const orphan = files.find((file) => !this.uploaded.has(file.sha));
    if (orphan !== undefined) {
      return json(400, {
        error: {
          code: 'missing_files',
          message: `${orphan.file} was never uploaded`,
        },
      });
    }

    // A deployment names the project it creates, exactly as the real API does.
    this.projects.add(project);
    const id = `dpl_${this.next++}`;
    const deployment: FakeDeployment = {
      id,
      project,
      url: `${project}.vercel.app`,
      meta: input.meta ?? {},
      files: files.map((file) => file.file),
      prebuilt: url.searchParams.get('prebuilt') === '1',
      pending: this.options.pollsBeforeSettling ?? 1,
    };
    this.deployments.set(id, deployment);
    return json(200, {
      id,
      url: deployment.url,
      readyState: 'QUEUED',
      meta: deployment.meta,
    });
  }

  /** One read, which is also one tick of the deployment's progress. */
  private read(id: string): Response {
    const deployment = this.deployments.get(id);
    if (deployment === undefined) return json(404, notFound('no deployment'));
    if (deployment.pending > 0) {
      deployment.pending -= 1;
      return json(200, {
        id,
        url: deployment.url,
        readyState: 'BUILDING',
        meta: deployment.meta,
      });
    }
    const settled = this.options.settlesOn ?? 'READY';
    if (settled === 'READY') this.production.set(deployment.project, id);
    return json(200, {
      id,
      url: deployment.url,
      readyState: settled,
      meta: deployment.meta,
      ...(settled === 'READY'
        ? {}
        : {
            errorCode: 'BUILD_FAILED',
            errorMessage: 'the deployment did not succeed',
          }),
    });
  }

  private list(url: URL): Response {
    const project = url.searchParams.get('projectId') ?? '';
    const id = this.production.get(project);
    const deployment = id === undefined ? undefined : this.deployments.get(id);
    return json(200, {
      deployments:
        deployment === undefined
          ? []
          : [
              {
                uid: deployment.id,
                url: deployment.url,
                readyState: 'READY',
                meta: deployment.meta,
              },
            ],
      pagination: {
        count: deployment === undefined ? 0 : 1,
        next: null,
        prev: null,
      },
    });
  }
}

function notFound(message: string): unknown {
  return { error: { code: 'not_found', message } };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
