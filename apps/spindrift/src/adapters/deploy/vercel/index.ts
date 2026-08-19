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
 *
 * **A re-apply finds the deployment it already made.** The platform mints a new
 * deployment on every create — there is no name to server-side-apply against —
 * so every mechanism that can re-run an attempt (a lease reclaim, a crashed
 * reconciler, a rollout replacing the pod mid-apply) would otherwise be another
 * production deployment. `apply` therefore queries for a deployment carrying
 * this Deploy's {@link DEPLOY_META} before creating one, and adopts what it
 * finds unless the platform already called it failed — a failed deployment
 * never served, so creating its successor *is* the retry. The platform offers
 * no unique-name constraint to lean on, so query-then-create is not atomic:
 * the window is one list read wide, and a refused list read falls through to
 * create rather than blocking the deploy — which is exactly the behaviour a
 * re-run had before the query existed.
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
  type Artifact,
  type ArtifactType,
  artifactAddress,
  type DesiredState,
} from '../../../domain/desired-state.ts';
import {
  targetLabel,
  type VercelAdapterConnection,
} from '../../../domain/target.ts';
import { vercelProjectName } from '../../../domain/vercel-project.ts';
import type { SurfaceProbe } from '../../../domain/vessel.ts';
import { fetchableBundleUrl } from '../../../storage/signed-url.ts';
import {
  type TokenChecklistSubject,
  tokenChecklist,
  tokenSurfaceProbe,
} from '../cloud/checklist.ts';
import type { FederationOptions } from '../cloud/federation.ts';
import {
  CloudHttp,
  type CloudResponse,
  type Fetcher,
  type TokenProvider,
} from '../cloud/http.ts';
import {
  cloudWriteFailure,
  missing,
  type Outcome,
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
import { type DeployEvents, deployEvents, internalFailure } from '../events.ts';
import { parseScopedRef, scopedRef } from '../ref.ts';
import {
  ArtifactUnavailable,
  type BundleFile,
  bundleFailure,
  readBundle,
} from '../static/bundle.ts';
import { fetchableStagedAddress, STAGED_SCHEME } from '../static/index.ts';
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
  /**
   * How this installation signs for an object in its source depot, or `null`
   * where it configured none.
   *
   * A third thing, and not a third *identity*: a supplied upload was never
   * built, so its bytes are a `gs://` object rather than a registry reference,
   * and reading one takes a signature rather than a bearer. Signing is
   * `signBlob` under the *federated* identity, before impersonation, which is
   * why this is the federation itself and not a token provider —
   * `storage/signed-url.ts` is where that distinction is written down.
   */
  readonly federation?: FederationOptions | null;
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

/**
 * The platform's own API root — one hostname for every team, because Vercel
 * runs a single control plane rather than one per customer.
 * `VercelConnection.endpoint` used to be required and typed into the connect
 * form on the theory that it was connection material the way a cluster's
 * `apiServer` is; it never varied between installations, so this is now the
 * default applied wherever `connection.endpoint` is read, with the Target's
 * own value kept only as an override for a perimeter or a mirror in front of
 * the real API.
 */
export const DEFAULT_ENDPOINT = 'https://api.vercel.com';

/**
 * Where a prebuilt deployment's files are addressed from.
 *
 * The platform's builder writes into `.vercel/output` and its reader expects
 * that path on the deployment, so the two have to agree. The artifact carries
 * the directory's contents rather than the directory, which is what keeps a
 * `vercel-output` artifact readable as the ordinary single-layer tar every
 * other files-shaped artifact is.
 */
const BUILD_OUTPUT_PREFIX = '.vercel/output/';

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
  /**
   * §6's table, one row further down: an edge site takes files — and this one
   * also takes the platform's own build output.
   *
   * Both, not one. `vercel-output` is what a Component built for this Target
   * renders to, and it is the shape that carries functions; `files` is still
   * accepted because §4's supplied artifact — a finished site somebody uploaded
   * — is that shape and has no build to have produced anything richer.
   */
  readonly artifactTypes: readonly ArtifactType[] = ['vercel-output', 'files'];

  private readonly events: DeployEvents;

  constructor(private readonly options: VercelAdapterOptions) {
    this.events = deployEvents(options.now);
  }

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return internalFailure('this Target is not a Vercel Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        `Vercel does not accept a ${desired.artifact.type} artifact`,
      );
    }
    if (desired.reach !== 'public') {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        `Vercel serves a public reach only, and this Component asks for ${desired.reach} (§9)`,
      );
    }
    if (desired.auth === 'proxy') {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        'Vercel has no authenticated edge Spindrift can put in front of a Component (§9)',
      );
    }

    // Same choice the other files backends make — literally, via the same
    // predicate — with a different identity doing the reading: a staged address
    // is an upload's own and is fetched as such, and among registry references
    // only one in the installation's Google-family artifacts registry is
    // readable with the federated token this adapter is handed for exactly that.
    const staged = artifactAddress(desired.artifact);
    const location =
      fetchableStagedAddress(staged) ??
      googleRegistryRef(desired.artifact.refs);
    if (location === null) {
      yield this.events.status('FAILED', { reason: 'ARTIFACT_UNAVAILABLE' });
      return {
        phase: 'FAILED',
        reason: 'ARTIFACT_UNAVAILABLE',
        detail: unfetchableArtifact(desired.artifact, staged),
      };
    }

    const project = projectName(desired);
    const ref = refOf(connection, project);
    const http = this.http(connection);

    yield this.events.status('APPLYING', { resource: project });

    // The idempotency read — see the file header. Before any byte is fetched
    // or uploaded, because an adopted deployment needs none of that work done
    // again: the platform already holds its files.
    const existing = await this.findDeployment(
      http,
      connection,
      project,
      desired.deploy,
    );
    if (
      existing !== null &&
      phaseOf(existing.readyState).phase !== 'FAILED' &&
      existing.uid !== undefined
    ) {
      yield this.events.log(
        `deployment ${existing.uid} already carries this Deploy — adopting it instead of creating another`,
        project,
      );
      return yield* this.release(
        http,
        connection,
        project,
        existing.uid,
        ref,
        desired,
      );
    }

    let files: readonly BundleFile[];
    try {
      files = await this.fetchBundle(http, location);
    } catch (cause) {
      const failure = bundleFailure(cause, ref);
      yield this.events.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }
    yield this.events.log(`the bundle holds ${files.length} files`, project);

    const uploaded = await this.upload(
      http,
      connection,
      files,
      desired.artifact.type === 'vercel-output' ? BUILD_OUTPUT_PREFIX : '',
    );
    if (uploaded.ok === false) {
      const failure = cloudWriteFailure(uploaded.failure, ref);
      yield this.events.status('FAILED', {
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
      yield this.events.status('FAILED', {
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
      yield this.events.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }
    yield this.events.log(`created deployment ${id}`, project);

    return yield* this.release(http, connection, project, id, ref, desired);
  }

  /**
   * The tail every deployment takes to its verdict, created or adopted: the
   * vanity name goes on (§9's one record re-point — a domain on the project
   * that is already serving), and then the platform is polled to its answer.
   */
  private async *release(
    http: CloudHttp,
    connection: VercelAdapterConnection,
    project: string,
    id: string,
    ref: DeployRef,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    if (desired.hostname.vanity !== undefined) {
      const attached = await this.attachDomain(
        http,
        connection,
        project,
        desired.hostname.vanity,
      );
      if (attached.ok === false) {
        const failure = cloudWriteFailure(attached.failure, ref);
        yield this.events.status('FAILED', {
          resource: project,
          reason: failure.reason,
        });
        return failure;
      }
      yield this.events.log(
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

  /**
   * Fetch the bundle and read it into files. Throws; `apply` catches.
   *
   * What is fetched and what is *named* part company here on purpose: a signed
   * URL is a bearer capability, so every sentence below names the address the
   * artifact carries and never the one that was minted from it.
   */
  private async fetchBundle(
    http: CloudHttp,
    location: string,
  ): Promise<readonly BundleFile[]> {
    let url: string;
    try {
      url = await fetchableBundleUrl(
        location,
        this.options.federation,
        this.options.fetch,
      );
    } catch (cause) {
      throw new ArtifactUnavailable(
        `the artifact at ${location} could not be signed for: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    if (/^https?:\/\//.test(url)) {
      const fetched = await http.bytes(url);
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
   * The deployment an earlier attempt of this Deploy already created, if any.
   *
   * Keyed by {@link DEPLOY_META}, which every create stamps: `meta-{key}` on
   * the list endpoint is what the first-party client's `list --meta` sends —
   * like `prebuilt` on the create, a contract that holds without being in the
   * public REST reference. `null` means none was found **or the read was
   * refused** — the two collapse on purpose, because a deploy blocked on a
   * flaky list read would trade a bounded duplicate-create window for a new
   * way to be stuck. See the file header.
   */
  private async findDeployment(
    http: CloudHttp,
    connection: VercelAdapterConnection,
    project: string,
    deploy: string,
  ): Promise<{ uid?: string; readyState?: string } | null> {
    const listed = await http.json<DeploymentList>({
      method: 'GET',
      path: '/v7/deployments',
      query: {
        projectId: project,
        target: 'production',
        [`meta-${DEPLOY_META}`]: deploy,
        limit: '1',
        teamId: connection.team,
      },
    });
    if (!listed.ok) return null;
    return listed.value?.deployments?.[0] ?? null;
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
    prefix: string,
  ): Promise<Outcome<readonly DeploymentFile[]>> {
    const referenced: DeploymentFile[] = [];
    for (const file of files) {
      const sha = sha1Hex(file.bytes);
      const uploaded = await http.upload({
        url: `${this.endpointOf(connection)}/v2/files?teamId=${encodeURIComponent(connection.team)}`,
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
      //
      // The prefix is what tells the two shapes apart, and it is the whole of
      // the difference on this side. A prebuilt deployment is addressed by the
      // paths the platform's own builder wrote — `.vercel/output/config.json`,
      // `.vercel/output/functions/…` — because that is where its reader looks
      // for them; the artifact holds that tree's *contents*, so the prefix goes
      // back on here rather than being carried through the registry.
      referenced.push({
        file: prefix + file.path.replace(/^\/+/, ''),
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
        // What `vercel deploy --prebuilt` is, on the wire: the uploaded files
        // are a Build Output API tree rather than a project, so the platform
        // serves them as the build it would otherwise have produced —
        // functions, routing and caching included — instead of trying to build
        // them.
        //
        // A query parameter, and not one the public REST reference documents:
        // it is what the first-party client sends
        // (`packages/client/src/utils/query-string.ts`), which is the contract
        // that actually holds.
        ...(desired.artifact.type === 'vercel-output' ? { prebuilt: '1' } : {}),
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
        //
        // **Only for a plain files artifact.** A prebuilt deployment already
        // says all of this by being prebuilt — the platform runs no build to
        // configure — and these are the *project's* persistent settings rather
        // than this deployment's. Sending them on every prebuilt deploy would
        // keep resetting the project's framework to "Other", which is the one
        // setting an operator opening the dashboard would most reasonably
        // expect to describe what is deployed.
        ...(desired.artifact.type === 'vercel-output'
          ? {}
          : {
              projectSettings: {
                framework: null,
                buildCommand: null,
                installCommand: null,
                devCommand: null,
                outputDirectory: null,
              },
            }),
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
      this.events.now() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
        yield this.events.status(status.phase, {
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
        yield this.events.log(status.detail, project);
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
      if (this.events.now() >= deadline) {
        yield this.events.status('FAILED', {
          resource: project,
          reason: 'TIMEOUT',
        });
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
      // §10's reach rule from the other side, and the one store this Target
      // reaches is the platform itself.
      //
      // The old answer here was the empty list, on the ground that nothing
      // runs so nothing could resolve a reference. That was true of a site
      // rendered to static files and false of one rendered to functions: a
      // function is a runtime, and it reads its configuration out of the
      // project's own environment. `store/vercel.ts` is that environment as a
      // store of record — which is also the only shape config can take here,
      // because the platform resolves no references and an environment
      // variable is a literal.
      //
      // A Target property rather than a Component one, which is why this is
      // unconditional: a Vercel Target can run functions, and whether a
      // particular Component does is settled by its artifact shape long after
      // discovery.
      reachableSecretStores: ['vercel'] as readonly StoreAdapter[],
    };
  }

  // --- plumbing ------------------------------------------------------------

  /** The API root this Target actually reaches, override or default. */
  private endpointOf(connection: VercelAdapterConnection): string {
    return connection.endpoint ?? DEFAULT_ENDPOINT;
  }

  private http(connection: VercelAdapterConnection): CloudHttp {
    return new CloudHttp({
      baseUrl: this.endpointOf(connection),
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private connectionOf(target: DeployTarget): VercelAdapterConnection | null {
    return target.connection.adapter === 'vercel' ? target.connection : null;
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

/**
 * Why nothing here can be fetched, said about the address that failed.
 *
 * The other files backends' three cases, worded for this one: no address at
 * all, a bundle staged somewhere nothing outside one process reaches, and a
 * built artifact homed only on a registry this identity cannot read. The middle
 * one used to take the last one's sentence, which sends an operator to IAM over
 * a bundle sitting on a disk.
 */
function unfetchableArtifact(
  artifact: Artifact,
  staged: string | null,
): string {
  if (artifact.refs.length === 0) {
    return 'the artifact carries no address to fetch it from';
  }
  if (staged !== null && STAGED_SCHEME.test(staged)) {
    return `the artifact is staged at ${staged}, which names this installation's own disk rather than an address Vercel can be fed from`;
  }
  const hosts = artifact.refs.map((ref) => ref.split('/')[0]).join(', ');
  return `Vercel is fed the bytes, and none of the artifact's homes (${hosts}) is a registry this installation's identity can read`;
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
  return tokenChecklist(probe, subjectOf(team));
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
  return tokenSurfaceProbe(probe, subjectOf(team));
}

/** What both answers above are said about — the product and the boundary. */
function subjectOf(team: string): TokenChecklistSubject {
  return { service: SERVICE_NAME, vessel: team, noun: 'team' };
}

/**
 * One project per (App, Component).
 *
 * The rule itself is `domain/vercel-project.ts`, because the store adapter has
 * to derive the identical name — it writes the environment variables the
 * deployment this creates will read, and two different answers would be config
 * on a project nothing deploys to.
 */
export function projectName(desired: DesiredState): string {
  return vercelProjectName(desired);
}

/** The adapter's own handle on what `apply` placed — opaque to core (§6). */
function refOf(
  connection: VercelAdapterConnection,
  project: string,
): DeployRef {
  return scopedRef(connection.team, 'projects', project);
}

/** The project this ref names on this connection, or `null` for another's. */
function parseRef(
  connection: VercelAdapterConnection,
  ref: DeployRef,
): string | null {
  return parseScopedRef(connection.team, 'projects', ref);
}

/** The sha1 of some bytes, hex — what the platform keys uploaded files by. */
function sha1Hex(bytes: Uint8Array<ArrayBuffer>): string {
  return new Bun.CryptoHasher('sha1').update(bytes).digest('hex');
}
