/**
 * The cloud build route (§4).
 *
 * §4 names three routes and this is the middle one: "a cloud build service", in
 * §14's shared artifacts project, next to the registry every artifact is pushed
 * to. It is the route with the strongest isolation claim — a managed worker the
 * connected repository's maintainers cannot reach — which is why it is the only
 * one this installation can honestly offer above L2.
 *
 * `LIVE_TEXT`, and it is earned rather than declared: the build service writes
 * its steps' output to a log service that can be read while the build runs, so
 * the timeline fills in as it goes (§4's amendment). The read is a poll with a
 * page cursor and not a stream, for the same reason `observe` is a poll — a
 * long-lived connection over the uplink is a connection that stays open while
 * delivering nothing.
 *
 * **What it submits is the shared BuildKit program**, not the service's own
 * source-to-image path. That is §4's "build is always separate from deploy"
 * applied one level down: a backend's convenience path is a second engine with
 * its own frontends, its own defaults, and its own idea of what a website is,
 * and having one would make "one engine, two frontends" false the moment a
 * build moved between routes.
 */

import { buildKitProgramFor } from './buildkit.ts';
import type {
  BuildAdapter,
  BuildEvent,
  BuildLevel,
  BuildResult,
  BuildSource,
  BuildSpec,
  LogFidelity,
} from './contract.ts';
import { parseBuildReport } from './report.ts';
import {
  buildFailed,
  buildSucceeded,
  deadlineFrom,
  type PollingOptions,
} from './route.ts';

/** The transport, in the shape `fetch` already has. */
export type Fetcher = (request: Request) => Promise<Response>;

/** Mints a bearer token per request. Never a stored credential (§13). */
export type TokenProvider = () => string | Promise<string>;

/** One build, as much of it as this route reads. */
interface CloudBuild {
  readonly id: string;
  readonly status?: string;
  readonly statusDetail?: string;
}

/** One log entry, as much of it as this route reads. */
interface LogEntry {
  /**
   * The log service's own identity for this entry. It is what makes re-reading
   * a window cheap: the same entry seen twice is recognised rather than
   * re-emitted, so the route never needs a cursor it cannot trust.
   */
  readonly insertId?: string;
  readonly textPayload?: string;
  readonly timestamp?: string;
}

/**
 * How far behind the newest entry already read a fresh search reaches.
 *
 * Entries are ingested out of order, so a window that started exactly at the
 * newest timestamp would step over anything that arrived late. A minute is
 * generous against the log service's own ingestion latency, and re-reading a
 * minute costs nothing because {@link keyOf} recognises what was already
 * emitted.
 */
const LOG_LATENESS_MS = 60_000;

/**
 * Pages one search follows before leaving the rest to the next poll.
 *
 * A bound rather than a limit anyone should hit: the next poll re-reads the
 * window anyway, so stopping early loses nothing but a few seconds of latency.
 */
const MAX_LOG_PAGES = 50;

/**
 * How long a concluded build's log is drained for before the route gives up on
 * the report.
 *
 * The build being over does not mean its log is: ingestion runs behind the
 * writer, and the report line is written in the final seconds of the run. This
 * is the only budget spent waiting for something that has already happened.
 */
const LOG_TAIL_TIMEOUT_MS = 60_000;

/** What the route carries between reads of one build's log. */
interface LogTail {
  /** Entries already emitted, by {@link keyOf}. */
  readonly seen: Set<string>;
  /** The newest entry timestamp seen, which anchors the next search's window. */
  newest: Date | null;
  /** Everything emitted, joined — what {@link parseBuildReport} reads. */
  log: string;
}

export interface CloudBuildRouteOptions extends PollingOptions {
  readonly name: string;
  /** The build service's API root, without a trailing slash. */
  readonly endpoint: string;
  /** The log service's API root, without a trailing slash. */
  readonly logsEndpoint: string;
  readonly project: string;
  readonly region: string;
  /** The BuildKit image the build step runs. Pinned by the installation. */
  readonly image: string;
  /** The zero-config BuildKit frontend the installation pinned (§4). */
  readonly zeroConfigFrontend: string;
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
}

/**
 * The statuses that mean the build is over.
 *
 * `EXPIRED` is in here and reads oddly: it is what a build that sat in the
 * queue past its own deadline becomes, so it is terminal even though nothing
 * ever ran.
 */
const TERMINAL = new Set([
  'SUCCESS',
  'FAILURE',
  'INTERNAL_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'EXPIRED',
]);

export class CloudBuildRoute implements BuildAdapter {
  readonly name: string;
  readonly logFidelity: LogFidelity = 'LIVE_TEXT';
  readonly provenanceBuilderId =
    'https://cloudbuild.googleapis.com/GoogleHostedWorker';
  /**
   * §16's profile level. A managed, ephemeral worker nobody outside the build
   * service can reach, running a program submitted by an authenticated caller —
   * that is the L3 claim this service makes for its own builds, and the profile
   * is a guarantee about the *route*. Whether a concrete Build achieved it is
   * Task 26's question, asked before signing and never taken on trust.
   */
  readonly buildLevel: BuildLevel = 3;

  constructor(private readonly options: CloudBuildRouteOptions) {
    this.name = options.name;
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    const now = this.options.now ?? (() => new Date());
    const logs = { backend: this.name, fidelity: this.logFidelity } as const;

    if (source.origin.type === 'repo') {
      // The bundle was staged once and every route fetches it (§15); a route
      // that cloned again would build a second tree from the same commit and
      // give the receipt nothing to join against.
      yield {
        type: 'log',
        at: now(),
        line: 'building from the staged bundle, not from the repository',
      };
    }

    const program = buildKitProgramFor(
      source,
      spec,
      this.options.zeroConfigFrontend,
    );

    let build: CloudBuild;
    try {
      build = await this.submit(program);
    } catch (error) {
      // §4 story 48: the failure before the build step has to be readable as
      // text, not as an empty log and a spinner.
      const detail = error instanceof Error ? error.message : String(error);
      yield { type: 'log', at: now(), line: `submit failed: ${detail}` };
      return buildFailed(
        logs,
        'TARGET_UNREACHABLE',
        `could not submit a build to ${this.options.project}: ${detail}`,
      );
    }

    yield { type: 'log', at: now(), line: `build ${build.id} submitted` };

    const budget = deadlineFrom(this.options);
    const tail: LogTail = { seen: new Set(), newest: null, log: '' };
    let status = build.status ?? 'QUEUED';
    let statusDetail = build.statusDetail;

    for (;;) {
      yield* this.readLog(build.id, tail, now);

      const current = await this.read(build.id);
      if (current !== null) {
        status = current.status ?? status;
        statusDetail = current.statusDetail ?? statusDetail;
      }
      if (TERMINAL.has(status)) break;

      if (budget.expired()) {
        return buildFailed(
          logs,
          'TIMEOUT',
          `build ${build.id} did not finish within the build budget`,
          { buildId: build.id, status },
        );
      }
      await budget.tick();
    }

    // The log read above happened *before* the status read that ended the loop,
    // so everything the build wrote in its last seconds is still unread — and
    // that is precisely the region that carries the report (`report.ts`: the
    // result travels the same way the logs do). A loop that stopped here would
    // record a green build as `succeeded but reported no artifact`, so the read
    // after the conclusion is the load-bearing one, not a courtesy.
    const drain = deadlineFrom({
      ...this.options,
      timeoutMs: LOG_TAIL_TIMEOUT_MS,
    });
    for (;;) {
      yield* this.readLog(build.id, tail, now);
      // A red build's report is not coming; one final read for the operator's
      // sake is the whole of what it is owed.
      if (status !== 'SUCCESS') break;
      if (parseBuildReport(tail.log) !== null) break;
      if (drain.expired()) break;
      await drain.tick();
    }

    const log = tail.log;

    if (status !== 'SUCCESS') {
      // The service's own `TIMEOUT` is core's `TIMEOUT` — a build that ran out
      // of its own budget indicts nobody either (§6's dash).
      return buildFailed(
        logs,
        status === 'TIMEOUT' || status === 'EXPIRED'
          ? 'TIMEOUT'
          : 'BUILD_FAILED',
        statusDetail ?? `build ${build.id} ended ${status}`,
        { buildId: build.id, status },
      );
    }

    const report = parseBuildReport(log);
    if (report === null) {
      return buildFailed(
        logs,
        'INTERNAL',
        `build ${build.id} succeeded but reported no artifact`,
        { buildId: build.id },
      );
    }

    return buildSucceeded({
      source,
      spec,
      logs,
      level: this.buildLevel,
      report: {
        ...report,
        // The build's own record of the run — §16's backend provenance, which
        // core verifies against the Target's minimum before signing. The route
        // reports it and never interprets it.
        statement: { build: build.id, project: this.options.project },
      },
    });
  }

  /** `projects/<p>/locations/<r>` — the parent every call hangs off. */
  private get parent(): string {
    return `projects/${this.options.project}/locations/${this.options.region}`;
  }

  private async submit(program: string): Promise<CloudBuild> {
    const operation = await this.json<{
      metadata?: { build?: CloudBuild };
    }>(`${this.options.endpoint}/v1/${this.parent}/builds`, {
      method: 'POST',
      body: {
        steps: [
          {
            name: this.options.image,
            entrypoint: 'sh',
            args: ['-c', program],
          },
        ],
        // Read, never pushed: the build writes to the log service and this
        // route polls it. Nothing is posted back to Spindrift (§4).
        options: { logging: 'CLOUD_LOGGING_ONLY' },
      },
    });
    const build = operation?.metadata?.build;
    if (build === undefined) {
      throw new TypeError('the build service named no build');
    }
    return build;
  }

  private read(id: string): Promise<CloudBuild | null> {
    return this.json<CloudBuild>(
      `${this.options.endpoint}/v1/${this.parent}/builds/${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
  }

  /**
   * Everything the build's log has gained since the last read, as events.
   *
   * **One poll is one search.** `entries.list`'s `nextPageToken` is a
   * continuation of *this* search — "retrieve the next batch of results from
   * the preceding call to this method" — and not a watermark on a live log. A
   * route that saved one and presented it seconds later would be paginating a
   * snapshot of the past, so the token is followed to the end of the search it
   * belongs to and then dropped.
   *
   * What replaces it is a timestamp window plus per-entry identity: each poll
   * re-searches the last {@link LOG_LATENESS_MS} and {@link keyOf} drops what
   * was already emitted. That is what tolerates out-of-order ingestion, which a
   * cursor never did.
   *
   * **An empty page carrying a token is not a caught-up log.** The vendor is
   * explicit that it means "the search found no log entries so far but it did
   * not have time to search all the possible log entries", so the token is
   * followed rather than read as an end.
   */
  private async *readLog(
    id: string,
    tail: LogTail,
    now: () => Date,
  ): AsyncGenerator<BuildEvent, void, void> {
    const filter = [
      `resource.labels.build_id="${id}"`,
      ...(tail.newest === null
        ? []
        : [
            `timestamp>="${new Date(tail.newest.getTime() - LOG_LATENESS_MS).toISOString()}"`,
          ]),
    ].join(' AND ');

    let token: string | undefined;
    for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
      let answer: { entries?: LogEntry[]; nextPageToken?: string } | null;
      try {
        answer = await this.json(
          `${this.options.logsEndpoint}/v2/entries:list`,
          {
            method: 'POST',
            body: {
              resourceNames: [`projects/${this.options.project}`],
              filter,
              orderBy: 'timestamp asc',
              pageSize: 200,
              ...(token === undefined ? {} : { pageToken: token }),
            },
          },
        );
      } catch {
        // A log service having a bad moment must not fail a build that is
        // otherwise going fine — the status read is the authority on whether it
        // is going fine, and the next pass searches the same window again.
        return;
      }

      for (const entry of answer?.entries ?? []) {
        const key = keyOf(entry);
        if (tail.seen.has(key)) continue;
        tail.seen.add(key);

        const at = timestampOf(entry);
        if (at !== null && (tail.newest === null || at > tail.newest)) {
          tail.newest = at;
        }

        const line = entry.textPayload;
        if (line === undefined || line.trim() === '') continue;
        tail.log += `${line}\n`;
        yield { type: 'log', at: at ?? now(), line };
      }

      token = answer?.nextPageToken;
      if (token === undefined || token === '') return;
    }
  }

  private async json<Result>(
    url: string,
    options: { method: string; body?: unknown },
  ): Promise<Result | null> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${await this.options.token()}`,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const request = new Request(url, {
      method: options.method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const send = this.options.fetch ?? ((input: Request) => fetch(input));
    const response = await send(request);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `${options.method} ${url} failed with ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as Result;
  }
}

/**
 * What makes two reads of the same entry the same entry.
 *
 * `insertId` is the log service's own identity and is what this relies on. The
 * fallback exists because an entry without one still has to be deduplicated
 * somehow, and it deliberately collapses two identical lines written in the
 * same second — losing a duplicated line is a smaller wrong than emitting the
 * whole window again on every poll.
 */
function keyOf(entry: LogEntry): string {
  if (entry.insertId !== undefined && entry.insertId !== '') {
    return entry.insertId;
  }
  return `${entry.timestamp ?? ''} ${entry.textPayload ?? ''}`;
}

function timestampOf(entry: LogEntry): Date | null {
  if (entry.timestamp === undefined) return null;
  const at = new Date(entry.timestamp);
  return Number.isNaN(at.getTime()) ? null : at;
}
