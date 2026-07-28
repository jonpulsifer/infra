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
  readonly textPayload?: string;
  readonly timestamp?: string;
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
    let cursor: string | undefined;
    let log = '';
    let status = build.status ?? 'QUEUED';
    let statusDetail = build.statusDetail;

    for (;;) {
      const page = await this.logPage(build.id, cursor);
      cursor = page.cursor;
      for (const entry of page.entries) {
        const line = entry.textPayload;
        if (line === undefined || line.trim() === '') continue;
        log += `${line}\n`;
        yield {
          type: 'log',
          at: entry.timestamp === undefined ? now() : new Date(entry.timestamp),
          line,
        };
      }

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
   * One page of the build's log, and where to resume.
   *
   * A page cursor rather than a timestamp window: entries arrive out of order
   * often enough that a window either repeats lines or drops them, and the log
   * service's own cursor is the only thing that knows which it already served.
   */
  private async logPage(
    id: string,
    cursor: string | undefined,
  ): Promise<{ entries: readonly LogEntry[]; cursor: string | undefined }> {
    let page: { entries?: LogEntry[]; nextPageToken?: string } | null = null;
    try {
      page = await this.json(`${this.options.logsEndpoint}/v2/entries:list`, {
        method: 'POST',
        body: {
          resourceNames: [`projects/${this.options.project}`],
          filter: `resource.labels.build_id="${id}"`,
          orderBy: 'timestamp asc',
          pageSize: 200,
          ...(cursor === undefined ? {} : { pageToken: cursor }),
        },
      });
    } catch {
      // A log service having a bad moment must not fail a build that is
      // otherwise going fine — the status read below is the authority on
      // whether it is going fine, and the next pass asks for the page again.
      return { entries: [], cursor };
    }
    return {
      entries: page?.entries ?? [],
      cursor: page?.nextPageToken ?? cursor,
    };
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
