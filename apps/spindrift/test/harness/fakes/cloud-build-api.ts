/**
 * The build and log HTTP APIs behind the real route. A build ends after
 * `duration` status reads, the log service serves only what was written by the
 * last status read, and a page token continues one frozen search.
 */

import type { Fetcher } from '../../../src/adapters/build/cloud-build.ts';
import { encodeBuildReport } from '../../../src/adapters/build/report.ts';

export const BUILD_HOST = 'https://builds.invalid';
export const LOGS_HOST = 'https://logs.invalid';

/** The timestamp of every build's first log line. */
const INGEST_EPOCH = Date.parse('2026-07-28T00:00:00.000Z');

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

export interface FakeCloudBuildOptions {
  /** Status reads that answer `WORKING` before the terminal status. */
  duration?: number;
  /** The terminal status, such as `SUCCESS`. */
  status?: string;
  /** The lines a build writes for its submitted program. */
  log?: (program: string) => readonly string[];
  /** Entries per page, whatever was asked: the real service often sends fewer. */
  pageSize?: number;
  /**
   * Each search's first page comes back empty with a token, which the vendor
   * documents as a search that ran out of time, not a caught-up log.
   */
  cutShort?: boolean;
  /** When set, submit answers with this HTTP status. */
  refuseSubmit?: number;
  /** When set, every log read answers 503. */
  breakLogs?: boolean;
  token?: string;
}

export interface BuildStep {
  name?: string;
  entrypoint?: string;
  args?: string[];
  env?: string[];
}

interface FakeEntry {
  insertId: string;
  textPayload: string;
  timestamp: string;
}

interface FakeBuild {
  id: string;
  reads: number;
  /** What the list endpoint filters by. */
  tags: readonly string[];
  cancelled: boolean;
  lines: readonly string[];
  /** Lines written so far, which the log service may not have ingested yet. */
  written: number;
  /** The lines the log service serves. */
  ingested: FakeEntry[];
}

/** One `entries.list` search, frozen when it was issued. */
interface FakeSearch {
  entries: readonly FakeEntry[];
  from: number;
}

export class FakeCloudBuild {
  readonly endpoint = BUILD_HOST;
  readonly logsEndpoint = LOGS_HOST;
  readonly requests: RecordedRequest[] = [];
  readonly programs: string[] = [];
  /** Every submitted build's steps, including the attestation step. */
  readonly steps: BuildStep[][] = [];
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

  /** The route's token provider; every request must bear this token. */
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

    // Both services refuse a request without the right bearer token.
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
   * Refuses a list with no tag filter: a route that dropped the filter would
   * cancel every build in the project.
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

  /** An ended build answers 400, as the service does. */
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
   * Each status read lets the build write. As in a BuildKit run, the last lines,
   * report included, land on the tick the status turns terminal.
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
   * With no `pageToken`, a new search over what is ingested now. A token
   * continues its search's frozen results and is not a watermark.
   */
  private logs(body: unknown): Response {
    if (this.options.breakLogs) return json(503, { error: 'log service down' });

    const request = (body ?? {}) as {
      filter?: string;
      pageToken?: string;
      resourceNames?: unknown;
    };
    // `entries.list` requires `resourceNames`, the parents to read from.
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

    return this.page(entries, 0, this.options.cutShort);
  }

  /** Catches up to what the build had written by its last status read. */
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

/** A green build's log, echoing the program's digest and destination. */
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
