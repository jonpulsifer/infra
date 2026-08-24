/**
 * A fake of the cloud build service and its log service (Task 25, § Seam 2).
 *
 * § Seam 2: "a fake of the far-side HTTP API behind the real client, with the
 * test asserting the requests that were made." So this is two APIs rather than
 * a fake adapter — the route's real submit body, its real status polling, and
 * its real page-cursored log reads all run against it.
 *
 * Three behaviours are modelled because the route has to survive them:
 *
 * - **A build does not finish on the first read.** `duration` is how many status
 *   reads it takes, so a route that submitted and assumed would fail here.
 * - **The log is ingested behind the writer.** A build writes as it runs and
 *   finishes writing when it finishes; the log service only serves what had
 *   been written by the previous status read. The report line lives in the last
 *   region a build writes, so a route that stops reading the moment the status
 *   turns terminal never sees it — which is the failure this models.
 * - **A page token continues one search, not the log.** `entries.list` mints a
 *   token against a *frozen* result set, exactly as the vendor documents it:
 *   "retrieve the next batch of results from the preceding call to this
 *   method". A route that saved one and presented it a poll later would be
 *   paginating a snapshot of the past, so this fake freezes the snapshot rather
 *   than treating the token as a watermark.
 */

import type { Fetcher } from '../../../src/adapters/build/cloud-build.ts';
import { encodeBuildReport } from '../../../src/adapters/build/report.ts';

export const BUILD_HOST = 'https://builds.invalid';
export const LOGS_HOST = 'https://logs.invalid';

/** When the first line of any build's log was ingested. */
const INGEST_EPOCH = Date.parse('2026-07-28T00:00:00.000Z');

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
  /**
   * Entries one page carries, whatever `pageSize` asked for. Small on purpose:
   * the real service answers with fewer than requested routinely, and a route
   * that read one page per poll would be permanently behind its own log.
   */
  pageSize?: number;
  /**
   * Answer the first page of every search empty *and with a token*, which the
   * vendor documents as "the search found no log entries so far but it did not
   * have time to search all the possible log entries" — not as a caught-up log.
   */
  cutShort?: boolean;
  /** When set, submitting is refused with this status. */
  refuseSubmit?: number;
  /** When set, every log read fails — the route must survive it. */
  breakLogs?: boolean;
  token?: string;
}

/** One step of a submitted build, as much of it as a test reads. */
export interface BuildStep {
  name?: string;
  entrypoint?: string;
  args?: string[];
  env?: string[];
}

/** One ingested log entry, in the shape the log service serves it. */
interface FakeEntry {
  insertId: string;
  textPayload: string;
  timestamp: string;
}

interface FakeBuild {
  id: string;
  reads: number;
  /** What the submit stamped on it — what the list endpoint filters by. */
  tags: readonly string[];
  /** Set by the cancel endpoint; the next status read reports `CANCELLED`. */
  cancelled: boolean;
  lines: readonly string[];
  /** Lines the build has written. Not yet what the log service will serve. */
  written: number;
  /** Lines the log service has ingested, which is what it will serve. */
  ingested: FakeEntry[];
}

/** One `entries.list` search, frozen at the moment it was issued. */
interface FakeSearch {
  entries: readonly FakeEntry[];
  from: number;
}

export class FakeCloudBuild {
  readonly endpoint = BUILD_HOST;
  readonly logsEndpoint = LOGS_HOST;
  readonly requests: RecordedRequest[] = [];
  /** Every program submitted — the assertion surface for what got built. */
  readonly programs: string[] = [];
  /**
   * Every submitted build's steps, in order.
   *
   * A build is more than its builder: the attestation is a step of its own, and
   * a route that stopped submitting it would still pass every assertion made
   * against {@link programs} alone.
   */
  readonly steps: BuildStep[][] = [];
  /** Every build id the cancel endpoint was asked to stop, in order. */
  readonly cancelled: string[] = [];

  private readonly builds = new Map<string, FakeBuild>();
  private readonly searches = new Map<string, FakeSearch>();
  private counter = 0;
  private searchCounter = 0;
  private readonly options: Required<
    Omit<FakeCloudBuildOptions, 'refuseSubmit' | 'token'>
  > &
    Pick<FakeCloudBuildOptions, 'refuseSubmit' | 'token'>;

  constructor(options: FakeCloudBuildOptions = {}) {
    this.options = {
      duration: options.duration ?? 1,
      status: options.status ?? 'SUCCESS',
      log: options.log ?? defaultBuildLog,
      pageSize: options.pageSize ?? 2,
      cutShort: options.cutShort ?? false,
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
      return this.submit(body as { steps?: BuildStep[]; tags?: string[] });
    }
    if (request.method === 'GET' && url.pathname.endsWith('/builds')) {
      return this.list(url.searchParams.get('filter'));
    }

    const cancel = url.pathname.match(/\/builds\/([^/:]+):cancel$/);
    if (cancel !== null && request.method === 'POST') {
      return this.cancel(cancel[1] ?? '');
    }

    const read = url.pathname.match(/\/builds\/([^/]+)$/);
    if (read !== null && request.method === 'GET')
      return this.read(read[1] ?? '');

    return json(404, { error: 'no such path' });
  };

  private submit(body: { steps?: BuildStep[]; tags?: string[] }): Response {
    if (this.options.refuseSubmit !== undefined) {
      return json(this.options.refuseSubmit, { error: 'refused' });
    }
    const steps = body.steps ?? [];
    const program = steps[0]?.args?.[1] ?? '';
    this.steps.push(steps);
    this.programs.push(program);
    this.counter += 1;
    const id = `build-${this.counter}`;
    this.builds.set(id, {
      id,
      reads: 0,
      tags: body.tags ?? [],
      cancelled: false,
      lines: this.options.log(program),
      written: 0,
      ingested: [],
    });
    return json(200, { metadata: { build: { id, status: 'QUEUED' } } });
  }

  /**
   * The builds under one tag. A list with no filter is refused rather than
   * answered with everything: a route that dropped the filter would cancel
   * every build in the project, and this is where that has to fail.
   */
  private list(filter: string | null): Response {
    const tag = /^tags="([^"]+)"$/.exec(filter ?? '')?.[1];
    if (tag === undefined) return json(400, { error: 'unsupported filter' });
    return json(200, {
      builds: [...this.builds.values()]
        .filter((build) => build.tags.includes(tag))
        .map((build) => ({ id: build.id, status: this.statusOf(build) })),
    });
  }

  /** A build that already ended cannot be cancelled, as the service says. */
  private cancel(id: string): Response {
    const build = this.builds.get(id);
    if (build === undefined) return json(404, { error: 'no such build' });
    if (build.reads > this.options.duration) {
      return json(400, { error: 'build is already finished' });
    }
    build.cancelled = true;
    this.cancelled.push(id);
    return json(200, { id, status: 'CANCELLED' });
  }

  private statusOf(build: FakeBuild): string {
    if (build.cancelled) return 'CANCELLED';
    return build.reads > this.options.duration
      ? this.options.status
      : 'WORKING';
  }

  /**
   * One status read, which is also when the build gets to write.
   *
   * The last region a build writes is the one that matters — `#8 exporting to
   * image` and the report line — and it is written on the same tick the status
   * turns terminal. That is not fake convenience; it is what a BuildKit run
   * does, and it is why the read *after* the terminal status is the load-bearing
   * one.
   */
  private read(id: string): Response {
    const build = this.builds.get(id);
    if (build === undefined) return json(404, { error: 'no such build' });
    build.reads += 1;
    const terminal = build.reads > this.options.duration;
    build.written = terminal
      ? build.lines.length
      : Math.max(
          build.written,
          Math.floor(
            (build.lines.length * build.reads) / (this.options.duration + 1),
          ),
        );
    return json(200, { id, status: this.statusOf(build) });
  }

  /**
   * One page of one build's log.
   *
   * A request with no `pageToken` is a *new* search over whatever has been
   * ingested by now; a request with one continues that earlier search's frozen
   * result set. Nothing here lets a token act as a watermark, because nothing
   * in the real API does.
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

    if (request.pageToken !== undefined) {
      const search = this.searches.get(request.pageToken);
      if (search === undefined) {
        return json(400, { error: 'invalid pageToken' });
      }
      return this.page(search.entries, search.from);
    }

    const filter = request.filter ?? '';
    const id = /build_id="([^"]+)"/.exec(filter)?.[1] ?? '';
    const build = this.builds.get(id);
    if (build === undefined) return json(200, { entries: [] });

    this.ingest(build);
    const since = /timestamp>="([^"]+)"/.exec(filter)?.[1];
    const entries =
      since === undefined
        ? [...build.ingested]
        : build.ingested.filter((entry) => entry.timestamp >= since);

    // A cut-short search answers nothing and hands back a token anyway. The
    // entries are still there; the route has to follow the token to see them.
    return this.page(entries, 0, this.options.cutShort);
  }

  /** Ingestion catches up to what the build had written at its last status read. */
  private ingest(build: FakeBuild): void {
    while (build.ingested.length < build.written) {
      const index = build.ingested.length;
      build.ingested.push({
        insertId: `${build.id}-${index}`,
        textPayload: build.lines[index] ?? '',
        timestamp: new Date(INGEST_EPOCH + index * 1_000).toISOString(),
      });
    }
  }

  private page(
    entries: readonly FakeEntry[],
    from: number,
    cutShort = false,
  ): Response {
    const slice = cutShort
      ? []
      : entries.slice(from, from + this.options.pageSize);
    const next = from + slice.length;
    if (next >= entries.length) return json(200, { entries: slice });

    this.searchCounter += 1;
    const token = `search-${this.searchCounter}`;
    this.searches.set(token, { entries, from: next });
    return json(200, { entries: slice, nextPageToken: token });
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
