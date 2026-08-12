/**
 * A fake of the repository host's HTTP API (Task 24, § Seam 2).
 *
 * § Seam 2: real backends are stood in for "the way `apps/ddnsd/main_test.go`
 * already does it in this repo: **a fake of the far-side HTTP API behind the
 * real client**, with the test asserting the requests that were made." So this
 * is the API, not a fake `RepositoryHost` — every assertion about
 * `GitHubApp` runs through its real URL construction, its real JSON bodies, its
 * real Git-data-API sequencing, and its real classification of a `404`.
 *
 * It models a small but genuine git object store: blobs, trees, commits, and
 * branches, with a `base_tree` layering that actually layers. That is what lets
 * a test ask the question Task 24's first acceptance criterion asks — *what is
 * in the tree the configuration PR wrote* — rather than asserting on the
 * requests and hoping they compose.
 *
 * Anything it does not model answers `404`, so a client that started calling a
 * new endpoint fails here rather than silently passing against a permissive
 * stand-in.
 *
 * **It negotiates content, because the real API does and a fake that did not
 * would be strictly more permissive than the thing it stands for.** That is not
 * a hypothetical: `jobLog` shipped asking for `text/plain`, every test passed,
 * and every build in production died on the `415` this fake now answers with.
 * The two endpoints that serve anything other than plain JSON are the two
 * modelled here — job logs, which negotiate as JSON and answer with text, and
 * contents, which answers raw bytes only to a client that asked for them. A
 * request whose `Accept` the real API would refuse is refused here.
 */
import { encodeBuildReport } from '../../../src/adapters/build/report.ts';
import type { Fetcher } from '../../../src/integrations/github/http.ts';

const BASE = 'https://api.git.invalid';

/** Every request the client made, for a test to assert against. */
export interface RecordedRequest {
  method: string;
  /** Path and query, without the base URL. */
  path: string;
  body: unknown;
  authorization: string | null;
  /** What the client said it would take — assertable, because it matters. */
  accept: string | null;
}

/** One pull request the client opened. */
export interface RecordedPullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
}

interface StoredCommit {
  tree: string;
  parents: string[];
}

/** One dispatch the client asked for. */
export interface RecordedDispatch {
  workflow: string;
  branch: string;
  inputs: Record<string, string>;
}

/**
 * How this host's Actions behave.
 *
 * The two delays are what make the fake worth having: a dispatch that named its
 * run immediately, or a run that was finished the moment it was found, would let
 * a route that never polled pass — and polling is most of what the route does.
 */
export interface FakeActionsOptions {
  /** List calls before a dispatched run becomes visible. `0` is immediate. */
  discoveryDelay?: number;
  /** Status reads before the run completes. */
  duration?: number;
  /** How it ends. Anything but `success` is a failed build. */
  conclusion?: string;
  /**
   * The job log, given the spec that was dispatched. The default composes a
   * valid report, because a green run that reports nothing is its own test
   * rather than the state every other test wants to start from.
   */
  log?: (spec: Record<string, unknown>) => string;
  /**
   * The status the logs endpoint answers with. `200` serves the log; anything
   * else stands in for a host that concluded a run and then would not hand over
   * its text — the one failure a green run can still die of.
   */
  logStatus?: number;
  /**
   * List calls that answer `500` before the endpoint serves. Models the far
   * side flaking on the lookup for a run whose dispatch already worked.
   */
  listFailures?: number;
  /** Status reads that answer `500` before the endpoint serves. */
  statusFailures?: number;
}

interface FakeRun {
  id: number;
  name: string;
  reads: number;
  log: string;
}

export interface FakeGitHubOptions {
  /** `owner/name` of the one repository this host serves. */
  fullName?: string;
  defaultBranch?: string;
  /** The installation the App must present a token for. */
  installationId?: string;
  actions?: FakeActionsOptions;
}

/**
 * Object ids are a counter in hex, not a hash.
 *
 * They only have to be distinct and stable within one test, and a real digest
 * would make an assertion about a tree depend on the exact bytes of a YAML
 * comment.
 */
function objectId(counter: number): string {
  return counter.toString(16).padStart(40, '0');
}

/**
 * Whether an `Accept` names a media type the host will negotiate as JSON.
 *
 * Deliberately not a full RFC 7231 matcher — it exists to draw one line, the
 * one the real API's own refusal draws: "Must accept 'application/json'".
 * `application/vnd.github+json` is that, spelled the way GitHub spells it, and
 * `text/plain` is not.
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
  readonly fullName: string;
  readonly installationId: string;
  readonly requests: RecordedRequest[] = [];
  readonly pulls: RecordedPullRequest[] = [];
  /** Every commit whose archive was downloaded — "fetch once" is checkable. */
  readonly tarballs: string[] = [];
  /** Every workflow dispatch, in order — the assertion surface for a build. */
  readonly dispatches: RecordedDispatch[] = [];

  defaultBranch: string;

  /**
   * Set to stop answering anything. Models the whole of §15's lost access: an
   * installation removed from a repository, deleted, or suspended all present
   * as a `404` this client cannot tell apart.
   */
  accessLost = false;
  /** Set to answer every call with a quota refusal instead. */
  rateLimited = false;

  private readonly blobs = new Map<string, string>();
  private readonly trees = new Map<string, Map<string, string>>();
  private readonly commits = new Map<string, StoredCommit>();
  private readonly branches = new Map<string, string>();
  private counter = 0;
  private pullNumber = 0;
  private runNumber = 0;
  private listCalls = 0;
  private statusCalls = 0;
  private readonly runs: FakeRun[] = [];
  private readonly actions: Required<FakeActionsOptions>;

  constructor(options: FakeGitHubOptions = {}) {
    this.fullName = options.fullName ?? 'example/app';
    this.defaultBranch = options.defaultBranch ?? 'main';
    this.installationId = options.installationId ?? '4242';
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

  /** The commit a branch points at, or `undefined`. */
  head(branch: string): string | undefined {
    return this.branches.get(branch);
  }

  /** Every path and its contents at one commit — what a test asserts on. */
  filesAt(commit: string): Record<string, string> {
    const tree = this.trees.get(this.commits.get(commit)?.tree ?? '');
    const files: Record<string, string> = {};
    for (const [path, blob] of tree ?? []) {
      files[path] = this.blobs.get(blob) ?? '';
    }
    return files;
  }

  /** Put a commit carrying exactly these files on a branch. */
  commitFiles(branch: string, files: Record<string, string>): string {
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
    });
    this.branches.set(branch, commit);
    return commit;
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

  /** The host's own refusal, message and all, for an `Accept` it will not serve. */
  private unsupportedMediaType(accept: string | null): Response {
    return this.json(
      {
        message: `Unsupported 'Accept' header: '${accept ?? ''}'. Must accept 'application/json'.`,
        status: '415',
      },
      415,
    );
  }

  /** The transport to hand the real client. */
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

    if (this.accessLost) return this.notFound();

    if (url.pathname === '/user/installations' && request.method === 'GET') {
      return this.json({
        installations: [{ id: Number(this.installationId) }],
      });
    }

    if (
      url.pathname ===
        `/user/installations/${this.installationId}/repositories` &&
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

    const prefix = `/repos/${this.fullName}`;
    if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) {
      return this.notFound();
    }
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

  /**
   * The Actions half, which models one thing carefully: **a dispatch names no
   * run.** It answers `204`, and the run has to be found afterwards by the name
   * the caller stamped — so this fake creates the run without telling anyone,
   * makes it visible only after `discoveryDelay` list calls, and finishes it
   * after `duration` status reads.
   */
  private actionsEndpoints(
    rest: string,
    method: string,
    body: Record<string, unknown>,
    accept: string | null,
  ): Response | null {
    if (rest === '/installation' && method === 'GET') {
      return this.json({ id: Number(this.installationId) });
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
        // Exactly what the caller workflow's `run-name` would produce.
        name: `spindrift ${inputs.correlation ?? ''}`,
        reads: 0,
        log: this.actions.log(spec),
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
      const done = run.reads > this.actions.duration;
      return this.json({
        id: run.id,
        status: done ? 'completed' : 'in_progress',
        conclusion: done ? this.actions.conclusion : null,
      });
    }

    const jobs = rest.match(/^\/actions\/runs\/(\d+)\/jobs$/);
    if (jobs && method === 'GET') {
      const run = this.runs.find((each) => each.id === Number(jobs[1]));
      if (run === undefined) return this.notFound();
      const done = run.reads > this.actions.duration;
      return this.json({
        jobs: [
          {
            id: run.id,
            name: 'build',
            status: done ? 'completed' : 'in_progress',
            conclusion: done ? this.actions.conclusion : null,
            steps: [
              {
                name: 'Build and push',
                status: done ? 'completed' : 'in_progress',
                conclusion: done ? this.actions.conclusion : null,
              },
            ],
          },
        ],
      });
    }

    const log = rest.match(/^\/actions\/jobs\/(\d+)\/logs$/);
    if (log && method === 'GET') {
      // The endpoint negotiates as JSON and *answers* with a redirect to a
      // plain-text blob. Asking for the media type of the answer is the mistake
      // that reads as obviously correct, so it is the one refused first — before
      // the job is even looked up, exactly as the real API refuses it.
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

    // Trees answer for a tree id *or* a commit id, exactly as the real
    // endpoint does, and only `recursive=1` flattens. A client that forgot the
    // flag gets the top level here too, so "why is my monorepo one entry" is a
    // question this fake can be asked rather than one production answers.
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
      return this.commits.has(resolved)
        ? this.json({ sha: resolved })
        : this.notFound();
    }

    const contents = rest.match(/^\/contents\/(.+)$/);
    if (contents) {
      const ref = url.searchParams.get('ref') ?? this.defaultBranch;
      const at = this.branches.get(ref) ?? ref;
      const file = this.filesAt(at)[decodeURIComponent(contents[1] ?? '')];
      if (file === undefined) return this.notFound();
      // Raw bytes only to a client that asked for them. To anyone else this
      // endpoint answers metadata with the file base64'd inside it — so a caller
      // that dropped the raw media type reads a JSON envelope where it expected
      // a `spindrift.yaml`, here as in production.
      return accept === 'application/vnd.github.raw'
        ? new Response(file)
        : this.json({
            name: decodeURIComponent(contents[1] ?? ''),
            content: btoa(file),
            encoding: 'base64',
          });
    }

    const tarball = rest.match(/^\/tarball\/(.+)$/);
    if (tarball) {
      const at = decodeURIComponent(tarball[1] ?? '');
      if (!this.commits.has(at)) return this.notFound();
      this.tarballs.push(at);
      return new Response(new TextEncoder().encode(`tarball:${at}`));
    }

    if (rest.startsWith('/pulls')) {
      return this.json(
        this.pulls.map((p) => ({
          number: p.number,
          title: p.title,
          body: p.body,
          head: { ref: p.head },
          base: { ref: p.base },
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
      });
      return this.json({ sha: id }, 201);
    }

    const update = rest.match(/^\/git\/refs\/heads\/(.+)$/);
    if (update && method === 'PATCH') {
      const name = decodeURIComponent(update[1] ?? '');
      // The host's own answer, and not the one it is easy to assume: updating a
      // ref that is not there is a `422`, message and all. This fake said `404`
      // for years and the production client was written to match the fake, so
      // the create-the-branch path it falls through to was never once taken
      // against GitHub.
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
      const pull = {
        number: this.pullNumber,
        title: String(body.title ?? ''),
        body: String(body.body ?? ''),
        head: String(body.head ?? ''),
        base: String(body.base ?? ''),
      };
      this.pulls.push(pull);
      return this.json(pull, 201);
    }

    // Rewriting an open pull request's prose, which is what a second connect
    // does to the one it finds already standing on its branch.
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
 * What a green run's log looks like: some output, then the one line core reads.
 *
 * The bundle digest is echoed from the spec that was dispatched rather than
 * fixed, which is what lets a test assert §16's join is real — and what lets a
 * test break it deliberately by supplying its own log.
 */
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
