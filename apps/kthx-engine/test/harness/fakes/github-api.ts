/**
 * The GitHub REST API behind the real `GitHubApp`: a small git object store,
 * Actions runs, and the real `Accept` negotiation. Anything else answers 404.
 */
import { encodeBuildReport } from '../../../src/adapters/build/report.ts';
import type { Fetcher } from '../../../src/integrations/github/http.ts';
import { tarball } from '../tar.ts';

const BASE = 'https://api.git.invalid';

export interface RecordedRequest {
  method: string;
  /** Path and query, without the base URL. */
  path: string;
  body: unknown;
  authorization: string | null;
  accept: string | null;
}

export interface RecordedPullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  /** `'open'` until a test calls {@link FakeGitHub.closePullRequest}. */
  state: 'open' | 'closed';
}

interface StoredCommit {
  tree: string;
  parents: string[];
  message: string;
  /** `null` when the host cannot match the author to a user. */
  authorLogin: string | null;
  authorName: string;
  authoredAt: string;
}

export interface FakeCommitOptions {
  readonly message?: string;
  readonly authorLogin?: string | null;
  readonly authorName?: string;
  readonly authoredAt?: string;
}

export interface RecordedDispatch {
  workflow: string;
  branch: string;
  inputs: Record<string, string>;
}

/**
 * A dispatch answers 204 and names no run, so the caller finds the run by its
 * name after `discoveryDelay` list calls, and it ends after `duration` reads.
 */
export interface FakeActionsOptions {
  /** List calls before a dispatched run becomes visible. `0` is immediate. */
  discoveryDelay?: number;
  /** Status reads before the run completes. */
  duration?: number;
  /** Anything but `success` is a failed build. */
  conclusion?: string;
  /** The job log for the dispatched spec; the default ends in a valid report. */
  log?: (spec: Record<string, unknown>) => string;
  /** Anything but 200 withholds the log of a concluded run. */
  logStatus?: number;
  /** List calls that answer `500` before the endpoint serves. */
  listFailures?: number;
  /** Status reads that answer `500` before the endpoint serves. */
  statusFailures?: number;
}

interface FakeRun {
  id: number;
  name: string;
  reads: number;
  log: string;
  cancelled: boolean;
}

export interface FakeGitHubOptions {
  /** `owner/name` of the one repository this host serves. */
  fullName?: string;
  defaultBranch?: string;
  /** The installation id tokens are minted for. */
  installationId?: string;
  /** The account that installation sits on. */
  accountLogin?: string;
  /** Share it with the client under test, so both measure token expiry alike. */
  now?: () => Date;
  actions?: FakeActionsOptions;
}

/** GitHub installation tokens expire after an hour. */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/** A hex counter, since a real hash would tie tree assertions to file bytes. */
function objectId(counter: number): string {
  return counter.toString(16).padStart(40, '0');
}

/**
 * Draws only the line the real 415 draws: "Must accept 'application/json'",
 * which `application/vnd.github+json` satisfies and `text/plain` does not.
 */
function acceptsJson(accept: string | null): boolean {
  if (accept === null || accept.trim() === '') return true;
  return accept.split(',').some((entry) => {
    const media = entry.split(';')[0]?.trim() ?? '';
    return (
      media === '*/*' ||
      media === 'application/*' ||
      media === 'application/json' ||
      /^application\/vnd\.github(\.[^+]+)?\+json$/.test(media)
    );
  });
}

export class FakeGitHub {
  /** The current `owner/name`; {@link FakeGitHub.rename} moves it. */
  fullName: string;
  readonly installationId: string;
  readonly accountLogin: string;
  readonly requests: RecordedRequest[] = [];
  readonly pulls: RecordedPullRequest[] = [];
  readonly tarballs: string[] = [];
  readonly dispatches: RecordedDispatch[] = [];
  readonly cancels: number[] = [];

  defaultBranch: string;

  /**
   * Every call but a token mint answers 404, as a removed, deleted or suspended
   * installation does.
   */
  accessLost = false;
  /** Set to answer every call with a quota refusal. */
  rateLimited = false;

  /** Names this repository answered to before a {@link FakeGitHub.rename}. */
  private readonly previousNames = new Set<string>();
  private readonly blobs = new Map<string, string>();
  private readonly trees = new Map<string, Map<string, string>>();
  private readonly commits = new Map<string, StoredCommit>();
  private readonly branches = new Map<string, string>();
  private counter = 0;
  private pullNumber = 0;
  private runNumber = 0;
  private listCalls = 0;
  private statusCalls = 0;
  private tokenCounter = 0;
  private readonly now: () => Date;
  private readonly runs: FakeRun[] = [];
  private readonly actions: Required<FakeActionsOptions>;

  constructor(options: FakeGitHubOptions = {}) {
    this.fullName = options.fullName ?? 'example/app';
    this.defaultBranch = options.defaultBranch ?? 'main';
    this.installationId = options.installationId ?? '4242';
    this.accountLogin = options.accountLogin ?? 'example';
    this.now = options.now ?? (() => new Date());
    this.actions = {
      discoveryDelay: options.actions?.discoveryDelay ?? 1,
      duration: options.actions?.duration ?? 1,
      conclusion: options.actions?.conclusion ?? 'success',
      log: options.actions?.log ?? defaultBuildLog,
      logStatus: options.actions?.logStatus ?? 200,
      listFailures: options.actions?.listFailures ?? 0,
      statusFailures: options.actions?.statusFailures ?? 0,
    };
  }

  get baseUrl(): string {
    return BASE;
  }

  head(branch: string): string | undefined {
    return this.branches.get(branch);
  }

  filesAt(commit: string): Record<string, string> {
    const tree = this.trees.get(this.commits.get(commit)?.tree ?? '');
    const files: Record<string, string> = {};
    for (const [path, blob] of tree ?? []) {
      files[path] = this.blobs.get(blob) ?? '';
    }
    return files;
  }

  /** Commits exactly these files onto a branch, with no base tree. */
  commitFiles(
    branch: string,
    files: Record<string, string>,
    options: FakeCommitOptions = {},
  ): string {
    const tree = new Map<string, string>();
    for (const [path, contents] of Object.entries(files)) {
      tree.set(path, this.putBlob(contents));
    }
    const treeId = this.nextId();
    this.trees.set(treeId, tree);
    const commit = this.nextId();
    const parent = this.branches.get(branch);
    this.commits.set(commit, {
      tree: treeId,
      parents: parent === undefined ? [] : [parent],
      message: options.message ?? `commit ${commit}`,
      authorLogin:
        options.authorLogin === undefined
          ? this.accountLogin
          : options.authorLogin,
      authorName: options.authorName ?? 'Example Author',
      authoredAt: options.authoredAt ?? this.now().toISOString(),
    });
    this.branches.set(branch, commit);
    return commit;
  }

  /** Closes a pull request without merging it. */
  closePullRequest(number: number): void {
    const pull = this.pulls.find((candidate) => candidate.number === number);
    if (pull !== undefined) pull.state = 'closed';
  }

  /**
   * The old name keeps answering with the new `full_name`, since `fetch` follows
   * the host's 301 before the client sees a body.
   */
  rename(fullName: string): void {
    this.previousNames.add(this.fullName);
    this.fullName = fullName;
  }

  /** Pointing a branch back at an older commit models the API lagging a push. */
  setHead(branch: string, commit: string): void {
    this.branches.set(branch, commit);
  }

  private nextId(): string {
    this.counter += 1;
    return objectId(this.counter);
  }

  private putBlob(contents: string): string {
    const id = this.nextId();
    this.blobs.set(id, contents);
    return id;
  }

  private json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private notFound(): Response {
    return new Response('{"message":"Not Found"}', { status: 404 });
  }

  /** The host's own 415 body. */
  private unsupportedMediaType(accept: string | null): Response {
    return this.json(
      {
        message: `Unsupported 'Accept' header: '${accept ?? ''}'. Must accept 'application/json'.`,
        status: '415',
      },
      415,
    );
  }

  readonly fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    const raw = request.method === 'GET' ? null : await request.text();
    const accept = request.headers.get('Accept');
    this.requests.push({
      method: request.method,
      path,
      body: raw === null || raw === '' ? null : JSON.parse(raw),
      authorization: request.headers.get('Authorization'),
      accept,
    });

    if (this.rateLimited) {
      return new Response('{"message":"rate limit exceeded"}', {
        status: 403,
        headers: { 'X-RateLimit-Remaining': '0' },
      });
    }

    // Minting presents the App JWT, so it precedes the access check: an App that
    // lost a repository can still mint.
    const minting = url.pathname.match(
      /^\/app\/installations\/([^/]+)\/access_tokens$/,
    );
    if (minting && request.method === 'POST') {
      if (minting[1] !== this.installationId) return this.notFound();
      this.tokenCounter += 1;
      return this.json(
        {
          token: `installation-token-${this.tokenCounter}`,
          expires_at: new Date(
            this.now().getTime() + TOKEN_LIFETIME_MS,
          ).toISOString(),
        },
        201,
      );
    }

    if (this.accessLost) return this.notFound();

    // A bare array, as the real endpoint answers.
    if (url.pathname === '/app/installations' && request.method === 'GET') {
      return this.json([
        {
          id: Number(this.installationId),
          account: { login: this.accountLogin },
        },
      ]);
    }

    if (
      url.pathname === '/installation/repositories' &&
      request.method === 'GET'
    ) {
      return this.json({
        repositories: [
          {
            id: 1,
            full_name: this.fullName,
            default_branch: this.defaultBranch,
          },
        ],
      });
    }

    const prefix = [this.fullName, ...this.previousNames]
      .map((name) => `/repos/${name}`)
      .find(
        (candidate) =>
          url.pathname === candidate ||
          url.pathname.startsWith(`${candidate}/`),
      );
    if (prefix === undefined) return this.notFound();
    const rest = url.pathname.slice(prefix.length);

    if (rest === '' && request.method === 'GET') {
      return this.json({
        full_name: this.fullName,
        default_branch: this.defaultBranch,
      });
    }

    const body = raw === null || raw === '' ? {} : JSON.parse(raw);
    return (
      this.actionsEndpoints(rest, request.method, body, accept) ??
      this.readEndpoints(rest, url, request.method, accept) ??
      this.writeEndpoints(rest, request.method, body) ??
      this.notFound()
    );
  };

  /** Whether a run is over, and how: cancelled wins over the scripted end. */
  private concluded(run: FakeRun): {
    done: boolean;
    conclusion: string | null;
  } {
    if (run.cancelled) return { done: true, conclusion: 'cancelled' };
    const done = run.reads > this.actions.duration;
    return { done, conclusion: done ? this.actions.conclusion : null };
  }

  private actionsEndpoints(
    rest: string,
    method: string,
    body: Record<string, unknown>,
    accept: string | null,
  ): Response | null {
    if (rest === '/installation' && method === 'GET') {
      return this.json({
        id: Number(this.installationId),
        account: { login: this.accountLogin },
      });
    }

    const dispatch = rest.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/);
    if (dispatch && method === 'POST') {
      const inputs = (body.inputs ?? {}) as Record<string, string>;
      this.dispatches.push({
        workflow: decodeURIComponent(dispatch[1] ?? ''),
        branch: String(body.ref ?? ''),
        inputs,
      });
      this.runNumber += 1;
      const spec = JSON.parse(inputs.spec ?? '{}') as Record<string, unknown>;
      this.runs.push({
        id: this.runNumber,
        // What the caller workflow's `run-name` produces.
        name: `spindrift ${inputs.correlation ?? ''}`,
        reads: 0,
        log: this.actions.log(spec),
        cancelled: false,
      });
      return new Response(null, { status: 204 });
    }

    const list = rest.match(/^\/actions\/workflows\/([^/]+)\/runs$/);
    if (list && method === 'GET') {
      this.listCalls += 1;
      if (this.listCalls <= this.actions.listFailures) {
        return this.json({ message: 'Server Error' }, 500);
      }
      const visible =
        this.listCalls > this.actions.discoveryDelay ? this.runs : [];
      return this.json({
        workflow_runs: visible.map((run) => ({
          id: run.id,
          name: run.name,
          status: 'queued',
          conclusion: null,
          // A cancel from outside the dispatching process reads this.
          html_url: `https://github.com/${this.fullName}/actions/runs/${run.id}`,
        })),
      });
    }

    const read = rest.match(/^\/actions\/runs\/(\d+)$/);
    if (read && method === 'GET') {
      const run = this.runs.find((each) => each.id === Number(read[1]));
      if (run === undefined) return this.notFound();
      this.statusCalls += 1;
      if (this.statusCalls <= this.actions.statusFailures) {
        return this.json({ message: 'Server Error' }, 500);
      }
      run.reads += 1;
      const { done, conclusion } = this.concluded(run);
      return this.json({
        id: run.id,
        status: done ? 'completed' : 'in_progress',
        conclusion,
      });
    }

    const cancel = rest.match(/^\/actions\/runs\/(\d+)\/cancel$/);
    if (cancel && method === 'POST') {
      const run = this.runs.find((each) => each.id === Number(cancel[1]));
      if (run === undefined) return this.notFound();
      // A concluded run answers 409, as the host does.
      if (this.concluded(run).done) {
        return this.json({ message: 'Cannot cancel a workflow run' }, 409);
      }
      run.cancelled = true;
      this.cancels.push(run.id);
      return new Response(null, { status: 202 });
    }

    const jobs = rest.match(/^\/actions\/runs\/(\d+)\/jobs$/);
    if (jobs && method === 'GET') {
      const run = this.runs.find((each) => each.id === Number(jobs[1]));
      if (run === undefined) return this.notFound();
      const { done, conclusion } = this.concluded(run);
      return this.json({
        jobs: [
          {
            id: run.id,
            name: 'build',
            status: done ? 'completed' : 'in_progress',
            conclusion,
            steps: [
              {
                name: 'Build and push',
                status: done ? 'completed' : 'in_progress',
                conclusion,
              },
            ],
          },
        ],
      });
    }

    const log = rest.match(/^\/actions\/jobs\/(\d+)\/logs$/);
    if (log && method === 'GET') {
      // It negotiates as JSON but answers with plain text. The real API refuses
      // a non-JSON `Accept` before looking up the job.
      if (!acceptsJson(accept)) return this.unsupportedMediaType(accept);
      const run = this.runs.find((each) => each.id === Number(log[1]));
      if (run === undefined) return this.notFound();
      if (this.actions.logStatus !== 200) {
        return this.json({ message: 'Server Error' }, this.actions.logStatus);
      }
      return new Response(run.log);
    }

    return null;
  }

  private readEndpoints(
    rest: string,
    url: URL,
    method: string,
    accept: string | null,
  ): Response | null {
    if (method !== 'GET') return null;

    const branch = rest.match(/^\/git\/ref\/heads\/(.+)$/);
    if (branch) {
      const commit = this.branches.get(decodeURIComponent(branch[1] ?? ''));
      return commit === undefined
        ? this.notFound()
        : this.json({ object: { sha: commit } });
    }

    // A tree or commit id, as the real endpoint takes; `recursive` flattens.
    const gitTree = rest.match(/^\/git\/trees\/(.+)$/);
    if (gitTree) {
      const requested = decodeURIComponent(gitTree[1] ?? '');
      const treeId = this.commits.get(requested)?.tree ?? requested;
      const tree = this.trees.get(treeId);
      if (tree === undefined) return this.notFound();
      const recursive = url.searchParams.get('recursive') !== null;
      const entries = recursive
        ? [...tree.keys()].map((path) => ({ path, type: 'blob' }))
        : [
            ...new Map(
              [...tree.keys()].map((path) => {
                const [head = path, ...rest] = path.split('/');
                return [
                  head,
                  { path: head, type: rest.length === 0 ? 'blob' : 'tree' },
                ] as const;
              }),
            ).values(),
          ];
      return this.json({ sha: treeId, truncated: false, tree: entries });
    }

    const gitCommit = rest.match(/^\/git\/commits\/(.+)$/);
    if (gitCommit) {
      const stored = this.commits.get(gitCommit[1] ?? '');
      return stored === undefined
        ? this.notFound()
        : this.json({ sha: gitCommit[1], tree: { sha: stored.tree } });
    }

    const commit = rest.match(/^\/commits\/(.+)$/);
    if (commit) {
      const requested = decodeURIComponent(commit[1] ?? '');
      const resolved = this.branches.get(requested) ?? requested;
      const stored = this.commits.get(resolved);
      // The git commit under `commit`, and the host's matched user, or `null`,
      // under `author`.
      return stored === undefined
        ? this.notFound()
        : this.json({
            sha: resolved,
            commit: {
              message: stored.message,
              author: { name: stored.authorName, date: stored.authoredAt },
            },
            author:
              stored.authorLogin === null
                ? null
                : { login: stored.authorLogin },
          });
    }

    const contents = rest.match(/^\/contents\/(.+)$/);
    if (contents) {
      const ref = url.searchParams.get('ref') ?? this.defaultBranch;
      const at = this.branches.get(ref) ?? ref;
      const file = this.filesAt(at)[decodeURIComponent(contents[1] ?? '')];
      if (file === undefined) return this.notFound();
      // Raw bytes only for the raw media type; otherwise JSON with the file in
      // base64.
      return accept === 'application/vnd.github.raw'
        ? new Response(file)
        : this.json({
            name: decodeURIComponent(contents[1] ?? ''),
            content: btoa(file),
            encoding: 'base64',
          });
    }

    const archive = rest.match(/^\/tarball\/(.+)$/);
    if (archive) {
      const at = decodeURIComponent(archive[1] ?? '');
      if (!this.commits.has(at)) return this.notFound();
      this.tarballs.push(at);
      // A gzipped tar wrapping the tree in `owner-repo-sha/`, as GitHub serves
      // it and the build routes unwrap it.
      const root = `${this.fullName.replace('/', '-')}-${at.slice(0, 7)}`;
      const files = this.filesAt(at);
      return new Response(
        tarball(
          Object.keys(files)
            .sort()
            .map((path) => ({
              name: `${root}/${path}`,
              bytes: new TextEncoder().encode(files[path] ?? ''),
            })),
        ) as unknown as BodyInit,
      );
    }

    // Before the listing below, which `startsWith` would also match.
    const onePull = rest.match(/^\/pulls\/(\d+)$/);
    if (onePull) {
      const pull = this.pulls.find(
        (candidate) => candidate.number === Number(onePull[1]),
      );
      return pull === undefined
        ? this.notFound()
        : this.json({
            number: pull.number,
            title: pull.title,
            body: pull.body,
            head: { ref: pull.head },
            base: { ref: pull.base },
            state: pull.state,
          });
    }

    if (rest.startsWith('/pulls')) {
      return this.json(
        this.pulls.map((p) => ({
          number: p.number,
          title: p.title,
          body: p.body,
          head: { ref: p.head },
          base: { ref: p.base },
          state: p.state,
        })),
      );
    }

    return null;
  }

  private writeEndpoints(
    rest: string,
    method: string,
    body: Record<string, unknown>,
  ): Response | null {
    if (rest === '/git/blobs' && method === 'POST') {
      return this.json({ sha: this.putBlob(String(body.content ?? '')) }, 201);
    }

    if (rest === '/git/trees' && method === 'POST') {
      const base = this.trees.get(String(body.base_tree ?? ''));
      const tree = new Map(base ?? []);
      for (const entry of (body.tree ?? []) as {
        path: string;
        sha: string;
      }[]) {
        tree.set(entry.path, entry.sha);
      }
      const id = this.nextId();
      this.trees.set(id, tree);
      return this.json({ sha: id }, 201);
    }

    if (rest === '/git/commits' && method === 'POST') {
      const id = this.nextId();
      this.commits.set(id, {
        tree: String(body.tree ?? ''),
        parents: (body.parents ?? []) as string[],
        message: String(body.message ?? ''),
        // The host attributes a commit the App makes to its bot user.
        authorLogin: `${this.accountLogin}[bot]`,
        authorName: this.accountLogin,
        authoredAt: this.now().toISOString(),
      });
      return this.json({ sha: id }, 201);
    }

    const update = rest.match(/^\/git\/refs\/heads\/(.+)$/);
    if (update && method === 'PATCH') {
      const name = decodeURIComponent(update[1] ?? '');
      // The host answers 422 for a missing ref, where a 404 is easy to assume.
      if (!this.branches.has(name)) {
        return this.json({ message: 'Reference does not exist' }, 422);
      }
      this.branches.set(name, String(body.sha ?? ''));
      return this.json({ ref: `refs/heads/${name}` });
    }

    if (rest === '/git/refs' && method === 'POST') {
      const name = String(body.ref ?? '').replace('refs/heads/', '');
      this.branches.set(name, String(body.sha ?? ''));
      return this.json({ ref: body.ref }, 201);
    }

    if (rest === '/pulls' && method === 'POST') {
      this.pullNumber += 1;
      const pull: RecordedPullRequest = {
        number: this.pullNumber,
        title: String(body.title ?? ''),
        body: String(body.body ?? ''),
        head: String(body.head ?? ''),
        base: String(body.base ?? ''),
        state: 'open',
      };
      this.pulls.push(pull);
      return this.json(pull, 201);
    }

    // A second connect rewrites the open pull request on its branch.
    const editPull = rest.match(/^\/pulls\/(\d+)$/);
    if (editPull && method === 'PATCH') {
      const number = Number(editPull[1]);
      const pull = this.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return this.notFound();
      if (body.title !== undefined) pull.title = String(body.title);
      if (body.body !== undefined) pull.body = String(body.body);
      return this.json(pull);
    }

    return null;
  }
}

/**
 * A fresh RSA keypair: the private half as PEM, PKCS#8 or the PKCS#1 GitHub hands
 * out, and the public half as a WebCrypto key for verifying a JWT.
 */
export async function testAppKey(
  format: 'pkcs8' | 'pkcs1' = 'pkcs8',
): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  );
  const base64 = btoa(String.fromCharCode(...pkcs8));
  const lines = base64.match(/.{1,64}/g) ?? [];
  const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
  if (format === 'pkcs8') return { pem: pkcs8Pem, publicKey: pair.publicKey };
  const { createPrivateKey } = await import('node:crypto');
  return {
    pem: createPrivateKey(pkcs8Pem)
      .export({ type: 'pkcs1', format: 'pem' })
      .toString(),
    publicKey: pair.publicKey,
  };
}

/** A green run's log, whose report echoes the dispatched bundle digest. */
function defaultBuildLog(spec: Record<string, unknown>): string {
  const digest = `sha256:${'a'.repeat(64)}`;
  const destination = String(spec.destination ?? 'registry.invalid/app');
  return [
    '2026-07-28T00:00:00Z #1 [internal] load build definition',
    '2026-07-28T00:00:01Z #8 exporting to image',
    encodeBuildReport({
      bundleDigest: String(spec.bundleDigest ?? ''),
      digest,
      refs: [`${destination}@${digest}`],
      baseDigest: null,
    }),
  ].join('\n');
}
