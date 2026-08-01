/**
 * A fake of the cloud build service and its log service (Task 25, § Seam 2).
 *
 * § Seam 2: "a fake of the far-side HTTP API behind the real client, with the
 * test asserting the requests that were made." So this is two APIs rather than
 * a fake adapter — the route's real submit body, its real status polling, and
 * its real page-cursored log reads all run against it.
 *
 * Two behaviours are modelled because the route has to survive them:
 *
 * - **A build does not finish on the first read.** `duration` is how many status
 *   reads it takes, so a route that submitted and assumed would fail here.
 * - **The log arrives in pages, and the cursor is the only thing that knows
 *   what was already served.** A route that re-read page one would see its own
 *   output repeat, which is the bug the cursor exists to prevent.
 */

import type { Fetcher } from '../../../src/adapters/build/cloud-build.ts';
import { encodeBuildReport } from '../../../src/adapters/build/report.ts';

export const BUILD_HOST = 'https://builds.invalid';
export const LOGS_HOST = 'https://logs.invalid';

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

export interface FakeCloudBuildOptions {
  /** Status reads before the build reaches a terminal status. */
  duration?: number;
  /** How it ends, in the service's own vocabulary. */
  status?: string;
  /** Lines the build writes, given the program it was submitted with. */
  log?: (program: string) => readonly string[];
  /** When set, submitting is refused with this status. */
  refuseSubmit?: number;
  /** When set, every log read fails — the route must survive it. */
  breakLogs?: boolean;
  token?: string;
}

interface FakeBuild {
  id: string;
  reads: number;
  lines: readonly string[];
  /** How many lines have been served, which is what the cursor encodes. */
  served: number;
}

export class FakeCloudBuild {
  readonly endpoint = BUILD_HOST;
  readonly logsEndpoint = LOGS_HOST;
  readonly requests: RecordedRequest[] = [];
  /** Every program submitted — the assertion surface for what got built. */
  readonly programs: string[] = [];

  private readonly builds = new Map<string, FakeBuild>();
  private counter = 0;
  private readonly options: Required<
    Omit<FakeCloudBuildOptions, 'refuseSubmit' | 'token'>
  > &
    Pick<FakeCloudBuildOptions, 'refuseSubmit' | 'token'>;

  constructor(options: FakeCloudBuildOptions = {}) {
    this.options = {
      duration: options.duration ?? 1,
      status: options.status ?? 'SUCCESS',
      log: options.log ?? defaultBuildLog,
      breakLogs: options.breakLogs ?? false,
      ...(options.refuseSubmit === undefined
        ? {}
        : { refuseSubmit: options.refuseSubmit }),
      ...(options.token === undefined ? {} : { token: options.token }),
    };
  }

  /** Mint the token provider the route is constructed with. */
  token = (): string => this.options.token ?? 'federated-token';

  readonly fetch: Fetcher = async (request) => {
    const url = new URL(request.url);
    const raw = request.method === 'GET' ? null : await request.text();
    const body = raw === null || raw === '' ? null : JSON.parse(raw);
    this.requests.push({
      method: request.method,
      url: `${url.origin}${url.pathname}`,
      body,
      authorization: request.headers.get('Authorization'),
    });

    // Both services are authorized, and both refuse a request that is not.
    // The header was recorded and never read, so a route that stopped sending
    // it — or sent the wrong one — passed every test against a real API that
    // would answer `401`.
    if (request.headers.get('Authorization') !== `Bearer ${this.token()}`) {
      return json(401, { error: 'unauthenticated' });
    }

    if (url.origin === LOGS_HOST) return this.logs(body);
    if (url.origin !== BUILD_HOST) return json(404, { error: 'no such host' });

    if (request.method === 'POST' && url.pathname.endsWith('/builds')) {
      return this.submit(body as { steps?: { args?: string[] }[] });
    }

    const read = url.pathname.match(/\/builds\/([^/]+)$/);
    if (read !== null && request.method === 'GET')
      return this.read(read[1] ?? '');

    return json(404, { error: 'no such path' });
  };

  private submit(body: { steps?: { args?: string[] }[] }): Response {
    if (this.options.refuseSubmit !== undefined) {
      return json(this.options.refuseSubmit, { error: 'refused' });
    }
    const program = body.steps?.[0]?.args?.[1] ?? '';
    this.programs.push(program);
    this.counter += 1;
    const id = `build-${this.counter}`;
    this.builds.set(id, {
      id,
      reads: 0,
      lines: this.options.log(program),
      served: 0,
    });
    return json(200, { metadata: { build: { id, status: 'QUEUED' } } });
  }

  private read(id: string): Response {
    const build = this.builds.get(id);
    if (build === undefined) return json(404, { error: 'no such build' });
    build.reads += 1;
    return json(200, {
      id,
      status:
        build.reads > this.options.duration ? this.options.status : 'WORKING',
    });
  }

  /**
   * One page of one build's log.
   *
   * The cursor is "how many lines this build has already served", encoded as a
   * string — which is enough to catch a route that ignores it and enough to be
   * read by a test that wants to know how many pages there were.
   */
  private logs(body: unknown): Response {
    if (this.options.breakLogs) return json(503, { error: 'log service down' });

    const request = (body ?? {}) as {
      filter?: string;
      pageToken?: string;
      resourceNames?: unknown;
    };
    // `entries.list` documents `resourceNames` as the parents to read from. A
    // request without them is refused rather than answered, so a route that
    // dropped the field would fail here rather than only in production.
    if (
      !Array.isArray(request.resourceNames) ||
      request.resourceNames.length === 0
    ) {
      return json(400, { error: 'resourceNames is required' });
    }
    const id = /build_id="([^"]+)"/.exec(request.filter ?? '')?.[1] ?? '';
    const build = this.builds.get(id);
    if (build === undefined) return json(200, { entries: [] });

    const from = Number(request.pageToken ?? '0');
    const entries = build.lines.slice(from).map((line) => ({
      textPayload: line,
      timestamp: '2026-07-28T00:00:00Z',
    }));
    build.served = build.lines.length;
    return json(200, {
      entries,
      nextPageToken: String(build.lines.length),
    });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * What a green build writes: some output, then the one line core reads.
 *
 * The digests are read back out of the program the route submitted, so the
 * report echoes what this build was actually asked to do — which is what makes
 * §16's join a real check here rather than two constants agreeing.
 */
function defaultBuildLog(program: string): readonly string[] {
  const bundleDigest = /'(sha256:[^']+)'/.exec(program)?.[1] ?? '';
  const destination =
    /type=image,name=([^,]+),push=true/.exec(program)?.[1] ??
    'registry.invalid/app';
  const digest = `sha256:${'b'.repeat(64)}`;
  return [
    'Starting Step #0',
    '#8 exporting to image',
    encodeBuildReport({
      bundleDigest,
      digest,
      refs: [`${destination}@${digest}`],
      baseDigest: null,
    }),
    'Finished Step #0',
  ];
}
