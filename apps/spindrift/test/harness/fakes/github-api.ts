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
 */
import type { Fetcher } from '../../../src/integrations/github/http.ts';

const BASE = 'https://api.git.invalid';

/** How long a minted installation token lives, as the real host defines it. */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/** Every request the client made, for a test to assert against. */
export interface RecordedRequest {
  method: string;
  /** Path and query, without the base URL. */
  path: string;
  body: unknown;
  authorization: string | null;
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

export interface FakeGitHubOptions {
  /** `owner/name` of the one repository this host serves. */
  fullName?: string;
  defaultBranch?: string;
  /** The installation the App must present a token for. */
  installationId?: string;
  /**
   * The clock token expiry is measured from.
   *
   * Shared with the client under test on purpose: a token's lifetime is the one
   * thing the two sides have to agree about, and a fake using the wall clock
   * against a client using an injected one would re-mint on every call for
   * reasons that have nothing to do with the code being tested.
   */
  now?: () => Date;
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

export class FakeGitHub {
  readonly fullName: string;
  readonly installationId: string;
  readonly requests: RecordedRequest[] = [];
  readonly pulls: RecordedPullRequest[] = [];
  /** Every commit whose archive was downloaded — "fetch once" is checkable. */
  readonly tarballs: string[] = [];

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
  private tokenCounter = 0;
  private readonly now: () => Date;

  constructor(options: FakeGitHubOptions = {}) {
    this.fullName = options.fullName ?? 'example/app';
    this.defaultBranch = options.defaultBranch ?? 'main';
    this.installationId = options.installationId ?? '4242';
    this.now = options.now ?? (() => new Date());
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

  /** The transport to hand the real client. */
  readonly fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    const raw = request.method === 'GET' ? null : await request.text();
    this.requests.push({
      method: request.method,
      path,
      body: raw === null || raw === '' ? null : JSON.parse(raw),
      authorization: request.headers.get('Authorization'),
    });

    if (this.rateLimited) {
      return new Response('{"message":"rate limit exceeded"}', {
        status: 403,
        headers: { 'X-RateLimit-Remaining': '0' },
      });
    }

    // Minting an installation token is the one call that presents the App JWT
    // rather than a token, so it is answered before the access check: an App
    // whose installation was deleted still gets to ask.
    const minting = url.pathname.match(
      /^\/app\/installations\/([^/]+)\/access_tokens$/,
    );
    if (minting && request.method === 'POST') {
      if (minting[1] !== this.installationId) return this.notFound();
      this.tokenCounter += 1;
      const value = `installation-token-${this.tokenCounter}`;
      return this.json(
        {
          token: value,
          expires_at: new Date(
            this.now().getTime() + TOKEN_LIFETIME_MS,
          ).toISOString(),
        },
        201,
      );
    }

    if (this.accessLost) return this.notFound();

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
      this.readEndpoints(rest, url, request.method) ??
      this.writeEndpoints(rest, request.method, body) ??
      this.notFound()
    );
  };

  private readEndpoints(
    rest: string,
    url: URL,
    method: string,
  ): Response | null {
    if (method !== 'GET') return null;

    const branch = rest.match(/^\/git\/ref\/heads\/(.+)$/);
    if (branch) {
      const commit = this.branches.get(decodeURIComponent(branch[1] ?? ''));
      return commit === undefined
        ? this.notFound()
        : this.json({ object: { sha: commit } });
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
      return file === undefined ? this.notFound() : new Response(file);
    }

    const tarball = rest.match(/^\/tarball\/(.+)$/);
    if (tarball) {
      const at = decodeURIComponent(tarball[1] ?? '');
      if (!this.commits.has(at)) return this.notFound();
      this.tarballs.push(at);
      return new Response(new TextEncoder().encode(`tarball:${at}`));
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
      if (!this.branches.has(name)) return this.notFound();
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

    return null;
  }
}

/**
 * A throwaway RSA key in the one format {@link GitHubApp} accepts.
 *
 * Generated per call rather than checked in: a private key in a repository is a
 * private key in a repository, even a test one, and generating it here also
 * gives the test the matching public key to verify a signed JWT against.
 */
export async function testAppKey(): Promise<{
  pem: string;
  publicKey: CryptoKey;
}> {
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
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}
