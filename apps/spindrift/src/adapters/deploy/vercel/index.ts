/**
 * The Vercel deploy adapter (§6, §9).
 *
 * Accepts `files`, uploads them, and creates one deployment against a project
 * named for the Component. §6's `WAITING` is a real phase here — unlike the
 * other static backend, the platform queues and builds a deployment rather than
 * releasing it synchronously — so this adapter polls the deployment it just
 * created and ends on what the platform says.
 *
 * **Build stays separate from Deploy** (§4: "a platform's own build-from-source
 * path is never used, because fusing the two would force a rollback to
 * rebuild"). So this never hands Vercel a repository to build: the artifact was
 * built by whichever route the Target's minimum level selected — hosted CI, the
 * cloud service, bosun, in-cluster — and what crosses this seam is the finished
 * tree. `projectSettings` says so in the platform's own terms: no framework, no
 * install and no build command, and the uploaded files served as they are. A
 * rollback re-deploys a digest that already exists rather than building it a
 * second time, which is exactly what §4 bought.
 *
 * **`Public` only** (§9), for the reason `static/index.ts` gives at length: the
 * origin is an address the edge always answers on, so a non-public rendering
 * would ship with a bypassable origin. Placement excludes this backend for a
 * non-public Component by the ordinary reach join
 * (`ASSERTED_REACHES_BY_ADAPTER.vercel`), so one arriving here is core's bug and
 * is reported as `INTERNAL`.
 *
 * **Two identities, not one.** Every other adapter here holds one token because
 * the API it drives and the registry the artifact sits in are the same vendor's.
 * This one is driven with the installation's Vercel bearer and reads its bytes
 * out of the installation's own artifacts registry, which is a different far
 * side with a different credential — see {@link VercelAdapterOptions}.
 */
import type {
  StoreAdapter,
  TargetAdapter,
} from '../../../config/manifest.schema.ts';
import type {
  PrerequisiteResult,
  TargetDiscovery,
  TargetInspection,
} from '../../../domain/capabilities.ts';
import {
  type ArtifactType,
  artifactAddress,
  type DesiredState,
} from '../../../domain/desired-state.ts';
import {
  targetLabel,
  type VercelAdapterConnection,
} from '../../../domain/target.ts';
import type { SurfaceProbe } from '../../../domain/vessel.ts';
import { workloadName } from '../../../domain/workload-name.ts';
import {
  CloudHttp,
  type CloudResponse,
  type Fetcher,
  type TokenProvider,
} from '../cloud/http.ts';
import {
  type CloudFailure,
  cloudWriteFailure,
  orderedChecklist,
} from '../cloud/verdict.ts';
import type {
  DeployAdapter,
  DeployEvent,
  DeployPhase,
  DeployRef,
  DeployTarget,
  DeployVerdict,
  FailureReason,
  JobRuns,
  ObservedState,
  RuntimeLogPage,
  RuntimeLogSubject,
  StartedRun,
} from '../contract.ts';
import { BundleError, type BundleFile, readBundle } from '../static/bundle.ts';
import {
  googleRegistryRef,
  OciPullError,
  pullFilesLayer,
} from '../static/oci.ts';

export interface VercelAdapterOptions {
  /**
   * The platform bearer, minted per request from the installation Secret.
   *
   * §13's "nothing stored" is a rule about Targets, and this is the exception it
   * cannot cover: the platform federates outward only, so there is no projected
   * token to exchange for one. Held exactly where the 1Password Connect token is
   * — one installation-wide value read per call, never a column on a Target.
   */
  readonly token: TokenProvider;
  /**
   * What authorizes reading the artifact, which is not the same far side.
   *
   * The bytes live in the installation's artifacts registry (§14), so this is
   * the federated cloud token every other adapter already holds. Splitting them
   * is what keeps a Vercel bearer from being sent to a registry, and a cloud
   * token from being sent to Vercel.
   */
  readonly artifactToken: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How often the deployment is polled while it queues and builds. */
  readonly pollIntervalMs?: number;
  /** How long an attempt may run before it is `TIMEOUT` (§6). */
  readonly timeoutMs?: number;
}

/** How the operator would name the platform in a sentence about it. */
const SERVICE_NAME = 'Vercel';

/** A project name is capped at 100 characters of `[a-z0-9._-]`. */
const PROJECT_NAME_LIMIT = 100;

/**
 * The `meta` keys `observe` reads what is serving back out of.
 *
 * The platform stores files and has no notion of an artifact, so a deployment
 * created by something other than Spindrift reports an empty digest and shows
 * as drift — which is right, because it is.
 */
const DIGEST_META = 'spindriftDigest';
const DEPLOY_META = 'spindriftDeploy';

/** §17's three runtime questions, answered by one fact, written once. */
const NOTHING_RUNS = 'Static files are served by the Target.';

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

/** One deployment, as much of it as this adapter reads. */
interface Deployment {
  readonly id?: string;
  readonly url?: string;
  readonly readyState?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string | null;
  readonly meta?: Readonly<Record<string, string>>;
}

/** What a list of them answers with. */
interface DeploymentList {
  readonly deployments?: readonly {
    readonly uid?: string;
    readonly url?: string;
    readonly readyState?: string;
    readonly meta?: Readonly<Record<string, string>>;
  }[];
}

export class VercelDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter = 'vercel';
  /** §6's table, one row further down: an edge site takes files. */
  readonly artifactTypes: readonly ArtifactType[] = ['files'];

  constructor(private readonly options: VercelAdapterOptions) {}

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return this.internal('this Target is not a Vercel Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        `Vercel does not accept a ${desired.artifact.type} artifact`,
      );
    }
    if (desired.reach !== 'public') {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        `Vercel serves a public reach only, and this Component asks for ${desired.reach} (§9)`,
      );
    }
    if (desired.auth === 'proxy') {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        'Vercel has no authenticated edge Spindrift can put in front of a Component (§9)',
      );
    }

    // Same choice the other files backend makes, with a different identity
    // doing the reading: a staged URL is an upload's own address and is fetched
    // as it stands, and among registry references only one in the installation's
    // Google-family artifacts registry is readable with the federated token
    // this adapter is handed for exactly that.
    const staged = artifactAddress(desired.artifact);
    const location = /^https?:\/\//.test(staged ?? '')
      ? staged
      : googleRegistryRef(desired.artifact.refs);
    if (location === null) {
      yield this.status('FAILED', { reason: 'ARTIFACT_UNAVAILABLE' });
      const hosts = desired.artifact.refs
        .map((ref) => ref.split('/')[0])
        .join(', ');
      return {
        phase: 'FAILED',
        reason: 'ARTIFACT_UNAVAILABLE',
        detail:
          desired.artifact.refs.length === 0
            ? 'the artifact carries no address to fetch it from'
            : `Vercel is fed the bytes, and none of the artifact's homes (${hosts}) is a registry this installation's identity can read`,
      };
    }

    const project = projectName(desired);
    const ref = refOf(connection, project);
    const http = this.http(connection);

    yield this.status('APPLYING', { resource: project });

    let files: readonly BundleFile[];
    try {
      files = await this.fetchBundle(http, location);
    } catch (cause) {
      const failure = bundleFailure(cause, ref);
      yield this.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }
    yield this.log(`the bundle holds ${files.length} files`, project);

    const uploaded = await this.upload(http, connection, files);
    if (uploaded.ok === false) {
      const failure = cloudWriteFailure(uploaded.failure, ref);
      yield this.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }

    const created = await this.create(
      http,
      connection,
      project,
      desired,
      uploaded.value,
    );
    if (created.ok === false) {
      const failure = cloudWriteFailure(created.failure, ref);
      yield this.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }
    const id = created.value.id;
    if (id === undefined) {
      const failure = cloudWriteFailure(
        missing('the API created no deployment'),
        ref,
      );
      yield this.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }
    yield this.log(`created deployment ${id}`, project);

    // §9's one record re-point: the vanity name is a domain on the project that
    // is already serving, so moving an App here moves one name.
    if (desired.hostname.vanity !== undefined) {
      const attached = await this.attachDomain(
        http,
        connection,
        project,
        desired.hostname.vanity,
      );
      if (attached.ok === false) {
        const failure = cloudWriteFailure(attached.failure, ref);
        yield this.status('FAILED', {
          resource: project,
          reason: failure.reason,
        });
        return failure;
      }
      yield this.log(
        `the vanity name ${desired.hostname.vanity} is on this project`,
        project,
      );
    }

    return yield* this.awaitVerdict(http, connection, project, id, ref);
  }

  /**
   * What is serving, read from the platform's current production deployment.
   *
   * Not from the deployment `apply` created: a promote or a rollback performed
   * in the dashboard moves what production points at without telling Spindrift,
   * and reporting the deployment core made would report core's memory rather
   * than the platform's answer — which is the one thing `observe` exists not to
   * do (§6).
   */
  async observe(
    target: DeployTarget,
    ref: DeployRef,
  ): Promise<ObservedState | null> {
    const connection = this.connectionOf(target);
    if (connection === null) return null;
    const project = parseRef(connection, ref);
    if (project === null) return null;

    const listed = await this.http(connection).json<DeploymentList>({
      method: 'GET',
      path: '/v7/deployments',
      query: {
        projectId: project,
        target: 'production',
        limit: '1',
        teamId: connection.team,
      },
    });
    if (!listed.ok) return null;

    const latest = listed.value?.deployments?.[0];
    if (latest === undefined) return null;

    return {
      ref,
      phase: phaseOf(latest.readyState).phase,
      artifactDigest: latest.meta?.[DIGEST_META] ?? '',
    };
  }

  /** Idempotent: destroying a project that is already gone succeeds. */
  async destroy(target: DeployTarget, ref: DeployRef): Promise<void> {
    const connection = this.connectionOf(target);
    if (connection === null) return;
    const project = parseRef(connection, ref);
    if (project === null) return;

    const http = this.http(connection);
    const deletion = await http.json<unknown>({
      method: 'DELETE',
      path: `/v9/projects/${encodeURIComponent(project)}`,
      query: { teamId: connection.team },
    });
    if (deletion.ok) return;
    if (deletion.kind === 'status' && deletion.status === 404) return;
    throw new Error(
      `project ${project} could not be destroyed: ${
        deletion.kind === 'status'
          ? `${deletion.status}: ${deletion.message}`
          : deletion.message
      }`,
    );
  }

  async tail(
    _target: DeployTarget,
    _subject: RuntimeLogSubject,
  ): Promise<RuntimeLogPage> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  /** Nothing here runs, and saying so is the answer (§17). */
  async run(_target: DeployTarget, _ref: DeployRef): Promise<StartedRun> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  /** The same fact from the reading side. */
  async executions(_target: DeployTarget, _ref: DeployRef): Promise<JobRuns> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  /**
   * One pass of §13's checklist and §3's discovery, from one call.
   *
   * The three answers come from the shape of one refusal, exactly as the cloud
   * adapters' do — but the middle question is asked of a bearer rather than of a
   * federation, so the mapping is this adapter's own rather than
   * `cloud/checklist.ts`'s. A team's project list is what it asks: an answer
   * means the platform is up, this credential may act, and the team is there.
   */
  async inspect(target: DeployTarget): Promise<TargetInspection> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      throw new Error(`${targetLabel(target)} is not a Vercel Target`);
    }

    const probe = await this.http(connection).json<unknown>({
      method: 'GET',
      path: '/v9/projects',
      query: { limit: '1', teamId: connection.team },
    });

    return {
      prerequisites: orderedChecklist(
        vercelChecklist(probe, connection.team),
        this.adapter,
      ),
      discovery: this.discover(connection),
      surface: vercelSurfaceProbe(probe, connection.team),
    };
  }

  // --- apply's steps -------------------------------------------------------

  /** Fetch the bundle and read it into files. Throws; `apply` catches. */
  private async fetchBundle(
    http: CloudHttp,
    location: string,
  ): Promise<readonly BundleFile[]> {
    if (/^https?:\/\//.test(location)) {
      const fetched = await http.bytes(location);
      if (!fetched.ok) {
        throw new ArtifactUnavailable(
          `the artifact at ${location} could not be fetched: ${fetched.message}`,
        );
      }
      return readBundle(fetched.value);
    }
    let layer: Uint8Array<ArrayBuffer>;
    try {
      layer = await pullFilesLayer({
        ref: location,
        token: this.options.artifactToken,
        ...(this.options.fetch === undefined
          ? {}
          : { fetch: this.options.fetch }),
      });
    } catch (cause) {
      if (!(cause instanceof OciPullError)) throw cause;
      throw new ArtifactUnavailable(
        `the artifact at ${location} could not be fetched: ${cause.message}`,
      );
    }
    return readBundle(layer);
  }

  /**
   * Offer every file, and return what the deployment will reference.
   *
   * One request per file, which is the API's shape: there is no populate step
   * that asks which bytes the platform already holds, so a file it has is a
   * cheap `200` rather than a call that is skipped. The digest is a **SHA-1**
   * over the raw bytes — the platform's own choice, and what it keys uploaded
   * content by — so it is also what the deployment names each file with.
   */
  private async upload(
    http: CloudHttp,
    connection: VercelAdapterConnection,
    files: readonly BundleFile[],
  ): Promise<Outcome<readonly DeploymentFile[]>> {
    const referenced: DeploymentFile[] = [];
    for (const file of files) {
      const sha = sha1Hex(file.bytes);
      const uploaded = await http.upload({
        url: `${connection.endpoint}/v2/files?teamId=${encodeURIComponent(connection.team)}`,
        bytes: file.bytes,
        contentType: 'application/octet-stream',
        headers: {
          'x-vercel-digest': sha,
          'Content-Length': String(file.bytes.byteLength),
        },
      });
      if (!uploaded.ok) return { ok: false, failure: uploaded };
      // Rooted at the site with a leading slash is what the bundle reader
      // produces and what the other files backend wants; a deployment path is
      // relative to the deployment root, so the slash comes off here.
      referenced.push({
        file: file.path.replace(/^\/+/, ''),
        sha,
        size: file.bytes.byteLength,
      });
    }
    return { ok: true, value: referenced };
  }

  /** Create the production deployment these files are. */
  private async create(
    http: CloudHttp,
    connection: VercelAdapterConnection,
    project: string,
    desired: DesiredState,
    files: readonly DeploymentFile[],
  ): Promise<Outcome<Deployment>> {
    const created = await http.json<Deployment>({
      method: 'POST',
      path: '/v13/deployments',
      query: {
        teamId: connection.team,
        // The platform otherwise refuses a deployment whose detected framework
        // differs from the project's, waiting on a confirmation no controller
        // is there to give. What is being deployed is a finished tree, so there
        // is nothing here for detection to be right or wrong about.
        skipAutoDetectionConfirmation: '1',
      },
      body: {
        name: project,
        // Names the project the first deployment creates, and addresses it on
        // every one after that. Spindrift creates no team and no vessel (§14),
        // but a project is what it places — the peer of the other backend's
        // site — so this is a create rather than a prerequisite.
        project,
        target: 'production',
        files,
        meta: {
          [DIGEST_META]: desired.artifact.digest,
          [DEPLOY_META]: desired.deploy,
        },
        // §4's separation, in the platform's own vocabulary: nothing to detect,
        // nothing to install, nothing to build, and the uploaded tree served as
        // it is. A build here would be the second build §4 forbids.
        projectSettings: {
          framework: null,
          buildCommand: null,
          installCommand: null,
          devCommand: null,
          outputDirectory: null,
        },
      },
    });
    if (!created.ok) return { ok: false, failure: created };
    return { ok: true, value: created.value ?? {} };
  }

  /** Put the vanity name on this project (§9). An existing one is not an error. */
  private async attachDomain(
    http: CloudHttp,
    connection: VercelAdapterConnection,
    project: string,
    domain: string,
  ): Promise<Outcome<void>> {
    // Read first rather than tolerating the refusal: the platform answers `400`
    // both for a domain this project already has and for one it will not accept,
    // and a deploy that treated the second as the first would report a name that
    // resolves nowhere as attached.
    const existing = await http.json<unknown>({
      method: 'GET',
      path: `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`,
      query: { teamId: connection.team },
    });
    if (existing.ok) return { ok: true, value: undefined };

    const attached = await http.json<unknown>({
      method: 'POST',
      path: `/v10/projects/${encodeURIComponent(project)}/domains`,
      query: { teamId: connection.team },
      body: { name: domain },
    });
    if (attached.ok) return { ok: true, value: undefined };
    return { ok: false, failure: attached };
  }

  /**
   * Poll the deployment until the platform reaches a verdict (§6).
   *
   * `WAITING` is entered once and reported once: the states before `READY` are
   * the platform's own queue and build, and translating each of them into a
   * separate phase would put three events on the timeline that all mean the
   * same thing to a reader.
   */
  private async *awaitVerdict(
    http: CloudHttp,
    connection: VercelAdapterConnection,
    project: string,
    id: string,
    ref: DeployRef,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const deadline =
      this.clock() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let reported: DeployPhase = 'APPLYING';
    let said: string | undefined;

    for (;;) {
      const read = await http.json<Deployment>({
        method: 'GET',
        path: `/v13/deployments/${encodeURIComponent(id)}`,
        query: { teamId: connection.team },
      });
      // A read that failed is not a deployment that failed. The write landed —
      // this id came back from it — so a refused poll is retried until the
      // budget runs out, and `TIMEOUT` is the honest verdict if it never clears.
      const status = read.ok
        ? phaseOf(read.value?.readyState, read.value)
        : { phase: 'WAITING' as DeployPhase };

      if (status.phase !== reported) {
        reported = status.phase;
        yield this.status(status.phase, {
          resource: project,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          ...(status.detail === undefined ? {} : { detail: status.detail }),
        });
      }
      if (
        status.detail !== undefined &&
        status.detail !== said &&
        status.phase !== 'LIVE' &&
        status.phase !== 'FAILED'
      ) {
        said = status.detail;
        yield this.log(status.detail, project);
      }

      if (status.phase === 'LIVE') {
        // §9: the platform names its own. The `url` is a host without a scheme,
        // and an address core assembled from nothing is worse than none.
        const host = read.ok ? read.value?.url : undefined;
        return {
          phase: 'LIVE',
          ref,
          ...(host === undefined ? {} : { url: `https://${host}` }),
        };
      }
      if (status.phase === 'FAILED') {
        return {
          phase: 'FAILED',
          ref,
          reason: status.reason ?? 'BUILD_FAILED',
          ...(status.detail === undefined ? {} : { detail: status.detail }),
          debug: read.ok ? read.value : undefined,
        };
      }
      if (this.clock() >= deadline) {
        yield this.status('FAILED', { resource: project, reason: 'TIMEOUT' });
        return {
          phase: 'FAILED',
          ref,
          reason: 'TIMEOUT',
          detail: 'the deployment did not settle in time',
        };
      }
      await this.wait();
    }
  }

  // --- inspect's second half -----------------------------------------------

  private discover(connection: VercelAdapterConnection): TargetDiscovery {
    return {
      // Files are served, not run — nothing here for an architecture to be
      // wrong about.
      arch: [],
      gpu: false,
      resourceCeiling: {},
      persistence: false,
      postgres: false,
      valkey: false,
      egressFiltering: false,
      // Nothing is admitted: there is no image and no runtime, so reporting an
      // engine would make `verifiedDeploy` true of a Target that verifies
      // nothing (§32).
      policyEngine: { installed: false, mode: null },
      // §17's honest empty state: no process ever wrote a line here.
      logHistorySeconds: 0,
      servedHosts: connection.servedHosts ?? [],
      // Nothing is pulled — the bytes were uploaded, and the edge holds them.
      reachableRegistries: [],
      // §10's reach rule from the other side: no runtime, so no store is
      // reachable, which is why §10's website exception exists.
      reachableSecretStores: [] as readonly StoreAdapter[],
    };
  }

  // --- plumbing ------------------------------------------------------------

  private http(connection: VercelAdapterConnection): CloudHttp {
    return new CloudHttp({
      baseUrl: connection.endpoint,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private connectionOf(target: DeployTarget): VercelAdapterConnection | null {
    return target.connection.adapter === 'vercel' ? target.connection : null;
  }

  private internal(detail: string): DeployVerdict {
    return { phase: 'FAILED', reason: 'INTERNAL', detail };
  }

  private status(
    phase: DeployPhase,
    extra: { resource?: string; reason?: FailureReason; detail?: string } = {},
  ): DeployEvent {
    return { type: 'status', at: new Date(this.clock()), phase, ...extra };
  }

  private log(line: string, resource?: string): DeployEvent {
    return {
      type: 'log',
      at: new Date(this.clock()),
      line,
      ...(resource === undefined ? {} : { resource }),
    };
  }

  private clock(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async wait(): Promise<void> {
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    if (this.options.sleep !== undefined) {
      await this.options.sleep(interval);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** One file a deployment references, in the platform's own spelling. */
interface DeploymentFile {
  readonly file: string;
  readonly sha: string;
  readonly size: number;
}

/** The artifact was addressed and the bytes were not there (§6's platform blame). */
class ArtifactUnavailable extends Error {
  override readonly name = 'ArtifactUnavailable';
}

/** A step that either produced something or carries the refusal that stopped it. */
type Outcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: CloudFailure };

/** A far side that answered successfully and left out what was asked for. */
function missing(message: string): CloudFailure {
  return { ok: false, kind: 'transport', message };
}

/**
 * The platform's deployment state, in §6's phases.
 *
 * `CANCELED` and `BLOCKED` are `REJECTED` rather than a build failure: neither
 * is the code being wrong — one is somebody stopping the deployment, the other
 * is the account's own policy refusing it — and §6 blames the developer for
 * both because both are answered by changing what was asked for.
 */
function phaseOf(
  readyState: string | undefined,
  deployment?: Deployment,
): { phase: DeployPhase; reason?: FailureReason; detail?: string } {
  const detail =
    deployment?.errorMessage ??
    (deployment?.errorCode === undefined ? undefined : deployment.errorCode);
  switch (readyState) {
    case 'READY':
      return { phase: 'LIVE' };
    case 'ERROR':
      return {
        phase: 'FAILED',
        reason: 'BUILD_FAILED',
        ...(detail === null || detail === undefined ? {} : { detail }),
      };
    case 'CANCELED':
      return {
        phase: 'FAILED',
        reason: 'REJECTED',
        detail: detail ?? 'the deployment was canceled',
      };
    case 'BLOCKED':
      return {
        phase: 'FAILED',
        reason: 'REJECTED',
        detail: detail ?? 'the platform blocked this deployment',
      };
    default:
      return { phase: 'WAITING' };
  }
}

/**
 * §13's checklist, as a Vercel Target answers it.
 *
 * One call, three items, separated by the shape of the refusal — the same
 * reasoning `cloud/checklist.ts` sets out, with the middle question asked of a
 * bearer:
 *
 * | The probe said | Unmet | Because |
 * | --- | --- | --- |
 * | `200` | — | the platform answered and this credential may read the team |
 * | `401`/`403` | `API_TOKEN` | the token is missing, expired, or not scoped here |
 * | `404` | `VESSEL` | there is no such team, and Spindrift never creates one |
 * | anything else | all three | nothing was established, and saying so beats guessing |
 */
export function vercelChecklist(
  probe: CloudResponse<unknown>,
  team: string,
): readonly PrerequisiteResult[] {
  if (probe.ok) {
    return [
      { name: 'PLATFORM_API', met: true },
      { name: 'API_TOKEN', met: true },
      { name: 'VESSEL', met: true },
    ];
  }
  if (probe.kind === 'transport') {
    return allUnmet(`${SERVICE_NAME} could not be reached: ${probe.message}`);
  }
  if (probe.status === 401 || probe.status === 403) {
    return [
      { name: 'PLATFORM_API', met: true },
      {
        name: 'API_TOKEN',
        met: false,
        assessed: true,
        detail: `this installation's ${SERVICE_NAME} token may not act on ${team}: ${probe.message}`,
      },
      { name: 'VESSEL', ...notAssessed() },
    ];
  }
  if (probe.status === 404) {
    return [
      { name: 'PLATFORM_API', met: true },
      { name: 'API_TOKEN', met: true },
      {
        name: 'VESSEL',
        met: false,
        assessed: true,
        detail: `the team ${team} does not exist, and Spindrift never creates a vessel (§14)`,
      },
    ];
  }
  return allUnmet(`${SERVICE_NAME} answered ${probe.status}: ${probe.message}`);
}

/**
 * Whether that same probe established the team carries this surface.
 *
 * Never `absent`, and that is the honest answer rather than a gap: a team is
 * not a project with services to switch on — every team can hold projects — so
 * there is no refusal that means "this boundary does not do deployments". A
 * failed probe leaves the Target registered and unhealthy, where the loop
 * re-checks it.
 */
export function vercelSurfaceProbe(
  probe: CloudResponse<unknown>,
  team: string,
): SurfaceProbe {
  if (probe.ok) return { kind: 'carried' };
  return {
    kind: 'undetermined',
    detail:
      probe.kind === 'transport'
        ? `${SERVICE_NAME} could not be reached: ${probe.message}`
        : `${SERVICE_NAME} answered ${probe.status} for ${team}: ${probe.message}`,
  };
}

function allUnmet(detail: string) {
  return (['PLATFORM_API', 'API_TOKEN', 'VESSEL'] as const).map((name) => ({
    name,
    met: false,
    assessed: false,
    detail,
  }));
}

function notAssessed() {
  return {
    met: false,
    assessed: false,
    detail: `not assessed: the ${SERVICE_NAME} probe did not get far enough to check this`,
  };
}

/** One project per (App, Component), within the length the platform allows. */
export function projectName(desired: DesiredState): string {
  return workloadName(desired, PROJECT_NAME_LIMIT);
}

/** The adapter's own handle on what `apply` placed — opaque to core (§6). */
function refOf(
  connection: VercelAdapterConnection,
  project: string,
): DeployRef {
  return `${connection.team}/projects/${project}`;
}

/** The project this ref names on this connection, or `null` for another's. */
function parseRef(
  connection: VercelAdapterConnection,
  ref: DeployRef,
): string | null {
  const prefix = `${connection.team}/projects/`;
  if (!ref.startsWith(prefix)) return null;
  const project = ref.slice(prefix.length);
  return project.length === 0 || project.includes('/') ? null : project;
}

/** The sha1 of some bytes, hex — what the platform keys uploaded files by. */
function sha1Hex(bytes: Uint8Array<ArrayBuffer>): string {
  return new Bun.CryptoHasher('sha1').update(bytes).digest('hex');
}

/** A bundle that could not be read, in §6's vocabulary. */
function bundleFailure(
  cause: unknown,
  ref: DeployRef,
): Extract<DeployVerdict, { phase: 'FAILED' }> {
  if (cause instanceof ArtifactUnavailable) {
    return {
      phase: 'FAILED',
      ref,
      reason: 'ARTIFACT_UNAVAILABLE',
      detail: cause.message,
    };
  }
  if (cause instanceof BundleError) {
    // The bytes arrived and are not what a `files` artifact is: the build
    // produced something unusable, which §6 blames on the developer.
    return {
      phase: 'FAILED',
      ref,
      reason: 'BUILD_FAILED',
      detail: cause.message,
      debug: { code: cause.code },
    };
  }
  return {
    phase: 'FAILED',
    ref,
    reason: 'INTERNAL',
    detail: cause instanceof Error ? cause.message : String(cause),
  };
}
