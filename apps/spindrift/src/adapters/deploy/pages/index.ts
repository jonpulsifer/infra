/**
 * The edge static-hosting deploy adapter (§6, §9).
 *
 * A sibling of `deploy/static`, not a replacement: both accept `files`, both
 * serve `Public` only, and both put the bytes there themselves rather than
 * handing a runtime a reference. What differs is the boundary — an edge account
 * rather than a cloud project — and, load-bearingly, how a call to it is
 * authorized.
 *
 * **This is where §13's "nothing stored" meets a platform that federates no
 * identity.** Every other Target here is reached with a token minted per
 * request from a projected one; this platform's API has no such exchange to
 * make. So the credential is configured into the process rather than into a
 * row: `registry.ts` reads it from the environment and hands it in as the same
 * {@link TokenProvider} shape federation produces, and nothing about a Target,
 * a Vessel or a connect form can hold one. The rule §13 was protecting — a
 * credential is never a column, never in the manifest, never on a screen — is
 * intact; what is not available is the part of it that needed a far side
 * willing to trade tokens.
 *
 * **`Public` only** (§9), and by the same road the cloud static Target takes:
 * the site's own edge address answers whatever is put in front of it, so no
 * non-public rendering here has a non-bypassable origin. `ASSERTED_REACHES_BY_
 * ADAPTER['cloudflare-pages']` is `['public']`, so a Component asking for
 * anything else is excluded by the ordinary reach join — `REACH_UNSUPPORTED`,
 * not a special case — and one arriving at `apply` anyway is core's bug,
 * reported as `INTERNAL`.
 *
 * **The site names itself** (§9). The platform mints the address, so the
 * canonical name comes back on the verdict; the vanity name is attached to the
 * same project as a domain, which is what keeps "moving an App between backends
 * is one record re-point" true here too.
 *
 * **Nothing is labelled, so the digest travels in the deployment's commit
 * message.** The platform stores files and has no notion of an artifact, and a
 * deployment carries no free-form labels — but it does carry the trigger
 * metadata a direct upload supplies. `observe` reads the digest back out of it;
 * a deployment made by anything other than Spindrift carries no marker, reports
 * an empty digest, and shows as drift, which is correct because it is.
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
  type CloudflarePagesAdapterConnection,
  targetLabel,
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
  type AssetManifest,
  type Envelope,
  hashFiles,
  missing,
  type Outcome,
  unwrap,
  uploadAssets,
} from './assets.ts';

export interface PagesAdapterOptions {
  /**
   * Mints the account credential per call.
   *
   * The same shape federation produces, deliberately: what varies between this
   * backend and its siblings is where the string comes from, and a different
   * type here would push that difference into every call site.
   */
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  readonly now?: () => number;
}

/** How the operator would name the product in a sentence about enabling it. */
const SERVICE_NAME = 'Cloudflare Pages';

/**
 * The branch a project is created with, and the one a deployment names.
 *
 * A constant rather than a connection field, because it decides one thing —
 * whether a deployment is the live one or a preview — and there is only one
 * answer Spindrift wants. A project that already exists keeps its own; see
 * {@link PagesDeployAdapter.ensureProject}, which reads it back rather than
 * assuming this.
 */
const PRODUCTION_BRANCH = 'production';

/** A project name is capped here. See `domain/workload-name.ts`. */
const PROJECT_NAME_LIMIT = 58;

/** Where the digest and the deploy travel, since a deployment carries no labels. */
const DIGEST_MARKER = 'spindrift-digest=';
const DEPLOY_MARKER = 'spindrift-deploy=';

/**
 * The one sentence every runtime question here is answered with (§17).
 *
 * Three questions — what is it saying, run it, what has it run — and one fact
 * behind all three: files are served, never executed.
 */
const NOTHING_RUNS = 'Static files are served by the Target.';

/** One project, as much of it as this adapter reads. */
interface PagesProject {
  readonly name?: string;
  readonly subdomain?: string;
  readonly production_branch?: string;
}

/** One deployment, as much of it as this adapter reads. */
interface PagesDeployment {
  readonly id?: string;
  readonly url?: string;
  readonly latest_stage?: { readonly name?: string; readonly status?: string };
  readonly deployment_trigger?: {
    readonly metadata?: { readonly commit_message?: string };
  };
}

export class PagesDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter = 'cloudflare-pages';
  /** §6's table: static hosting takes files. */
  readonly artifactTypes: readonly ArtifactType[] = ['files'];

  constructor(private readonly options: PagesAdapterOptions) {}

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return this.internal('this Target is not a Cloudflare Pages Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        `Cloudflare Pages does not accept a ${desired.artifact.type} artifact`,
      );
    }
    if (desired.reach !== 'public') {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        `Cloudflare Pages serves a public reach only, and this Component asks for ${desired.reach} (§9)`,
      );
    }
    if (desired.auth === 'proxy') {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        'Cloudflare Pages has no authenticated edge to put in front of a Component (§9)',
      );
    }

    // **ponytail:** a staged URL only. This adapter fetches the bytes with its
    // own identity, and that identity is an account credential for *this*
    // platform — it authorizes nothing at a container registry, so a registry
    // reference is an address this Target genuinely cannot read rather than one
    // it has not got around to. The cloud static Target's OCI arm works because
    // its federated token is also its registry token; there is no equivalent
    // here until the build route can stage a `files` artifact somewhere this
    // can GET, which is what `depot`-shaped addresses already are. Give it the
    // registry arm when a credential-free pull path exists, not before.
    const staged = artifactAddress(desired.artifact);
    if (staged === null || !/^https?:\/\//.test(staged)) {
      yield this.status('FAILED', { reason: 'ARTIFACT_UNAVAILABLE' });
      return {
        phase: 'FAILED',
        reason: 'ARTIFACT_UNAVAILABLE',
        detail:
          desired.artifact.refs.length === 0
            ? 'the artifact carries no address to fetch it from'
            : `Cloudflare Pages fetches the bytes itself, and this artifact is addressed as ${staged} — a registry reference its account credential cannot read`,
      };
    }

    const project = projectName(desired);
    const ref = refOf(connection, project);
    const http = this.http(connection);

    yield this.status('APPLYING', { resource: project });

    let files: readonly BundleFile[];
    try {
      files = await this.fetchBundle(http, staged);
    } catch (cause) {
      const failure = bundleFailure(cause, ref);
      yield this.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }
    yield this.log(`the bundle holds ${files.length} files`, project);

    const ensured = await this.ensureProject(http, connection, project);
    if (ensured.ok === false) {
      const failure = cloudWriteFailure(ensured.failure, ref);
      yield this.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }

    // Collected rather than yielded directly: `uploadAssets` reports progress
    // through a callback because it is a loop over buckets, and a generator
    // cannot yield from inside somebody else's await.
    const lines: string[] = [];
    const uploaded = await uploadAssets({
      client: http,
      account: connection.account,
      endpoint: connection.endpoint,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
      project,
      files: hashFiles(files),
      onProgress: (line) => lines.push(line),
    });
    for (const line of lines) yield this.log(line, project);
    if (uploaded.ok === false) {
      const failure = cloudWriteFailure(uploaded.failure, ref);
      yield this.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }

    const released = await this.deploy(
      http,
      connection,
      project,
      ensured.value.production_branch ?? PRODUCTION_BRANCH,
      desired,
      uploaded.value,
    );
    if (released.ok === false) {
      const failure = cloudWriteFailure(released.failure, ref);
      yield this.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }
    yield this.log(`deployed ${released.value.id ?? project}`, project);

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

    // The deployment's own address is one deployment's; the project's subdomain
    // is what the production branch always answers on. §9 wants the canonical,
    // which is the second — the first changes every release.
    const address =
      ensured.value.subdomain === undefined
        ? released.value.url
        : `https://${ensured.value.subdomain}`;
    yield this.status('LIVE', { resource: project });
    return {
      phase: 'LIVE',
      ref,
      ...(address === undefined ? {} : { url: address }),
    };
  }

  /**
   * What is serving, read from the latest deployment rather than from what was
   * written.
   *
   * The digest comes out of the trigger metadata, which is the only place it
   * can come from: there is nowhere else on a deployment to put it. A
   * deployment made by something other than Spindrift therefore reports an
   * empty digest and shows as drift — which is right, because it is.
   */
  async observe(
    target: DeployTarget,
    ref: DeployRef,
  ): Promise<ObservedState | null> {
    const connection = this.connectionOf(target);
    if (connection === null) return null;
    const project = parseRef(connection, ref);
    if (project === null) return null;

    const listed = unwrap(
      await this.http(connection).json<Envelope<readonly PagesDeployment[]>>({
        method: 'GET',
        path: `${this.projectPath(connection, project)}/deployments`,
        query: { per_page: '1' },
      }),
    );
    if (!listed.ok) return null;

    const latest = listed.value?.[0];
    if (latest === undefined) return null;

    const phase = phaseOf(latest);
    return {
      ref,
      phase,
      artifactDigest: markerIn(
        latest.deployment_trigger?.metadata?.commit_message,
        DIGEST_MARKER,
      ),
      ...(phase === 'FAILED'
        ? {
            reason: 'UNHEALTHY' as FailureReason,
            detail: `the ${latest.latest_stage?.name ?? 'deployment'} stage reported ${latest.latest_stage?.status ?? 'a failure'}`,
          }
        : {}),
    };
  }

  async destroy(target: DeployTarget, ref: DeployRef): Promise<void> {
    const connection = this.connectionOf(target);
    if (connection === null) return;
    const project = parseRef(connection, ref);
    if (project === null) return;

    const http = this.http(connection);
    const deletion = await http.json<Envelope<unknown>>({
      method: 'DELETE',
      path: this.projectPath(connection, project),
    });

    // The DELETE's own status is not trusted either way — read the project back
    // instead. Absent is destroyed; present is a destroy that did not happen
    // and must not be reported as one.
    const read = await http.json<Envelope<PagesProject>>({
      method: 'GET',
      path: this.projectPath(connection, project),
    });
    if (!read.ok && read.kind === 'status' && read.status === 404) return;
    throw new Error(
      read.ok
        ? `project ${project} still exists after destroy${
            deletion.ok
              ? ''
              : ` (delete answered ${
                  deletion.kind === 'status'
                    ? `${deletion.status}: ${deletion.message}`
                    : deletion.message
                })`
          }`
        : `could not verify project ${project} was destroyed: ${
            read.kind === 'status'
              ? `${read.status}: ${read.message}`
              : read.message
          }`,
    );
  }

  async tail(
    _target: DeployTarget,
    _subject: RuntimeLogSubject,
  ): Promise<RuntimeLogPage> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  /**
   * There is nothing here to run, and saying so is the answer (§17).
   *
   * `KINDS_BY_ADAPTER['cloudflare-pages']` is `['website']`, so a job never
   * reaches this backend and this refusal is unreachable through placement. It
   * is written anyway, and as a refusal rather than left unimplemented, for the
   * reason `tail` returns its `none` arm: a contract every adapter answers is a
   * contract core can call without asking which one it is holding.
   */
  async run(_target: DeployTarget, _ref: DeployRef): Promise<StartedRun> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  /** The same fact from the reading side: no run ever happened here. */
  async executions(_target: DeployTarget, _ref: DeployRef): Promise<JobRuns> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  /** One pass of §13's checklist and §3's discovery, in one call. */
  async inspect(target: DeployTarget): Promise<TargetInspection> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      throw new Error(
        `${targetLabel(target)} is not a Cloudflare Pages Target`,
      );
    }

    const probe = await this.http(connection).json<Envelope<unknown>>({
      method: 'GET',
      path: `/accounts/${encodeURIComponent(connection.account)}/pages/projects`,
      query: { per_page: '1' },
    });

    return {
      prerequisites: orderedChecklist(
        pagesChecklist(probe, connection.account),
        this.adapter,
      ),
      discovery: this.discover(connection),
      surface: pagesSurfaceProbe(probe, connection.account),
    };
  }

  // --- apply's steps -------------------------------------------------------

  /** Fetch the staged bundle and read it into files. Throws; `apply` catches. */
  private async fetchBundle(
    http: CloudHttp,
    location: string,
  ): Promise<readonly BundleFile[]> {
    const fetched = await http.bytes(location);
    if (!fetched.ok) {
      // §6 blames the **platform** for an artifact that cannot be fetched, and
      // this is exactly that: the build is green and the bytes are not there.
      throw new ArtifactUnavailable(
        `the artifact at ${location} could not be fetched: ${fetched.message}`,
      );
    }
    return readBundle(fetched.value);
  }

  /**
   * The project, ensured rather than created.
   *
   * A project is a durable place and a deploy is a revision of what it serves.
   * So the only question is whether the place exists, and "it already does" is
   * this function succeeding — which is also why the existing project's own
   * production branch is what comes back, rather than the constant this would
   * have created it with.
   */
  private async ensureProject(
    http: CloudHttp,
    connection: CloudflarePagesAdapterConnection,
    project: string,
  ): Promise<Outcome<PagesProject>> {
    const read = await http.json<Envelope<PagesProject>>({
      method: 'GET',
      path: this.projectPath(connection, project),
    });
    if (read.ok) {
      const existing = unwrap(read);
      if (existing.ok && existing.value !== undefined) {
        return { ok: true, value: existing.value };
      }
    }
    if (!read.ok && !(read.kind === 'status' && read.status === 404)) {
      return { ok: false, failure: read };
    }

    const created = await http.json<Envelope<PagesProject>>({
      method: 'POST',
      path: `/accounts/${encodeURIComponent(connection.account)}/pages/projects`,
      body: { name: project, production_branch: PRODUCTION_BRANCH },
    });
    // Losing a create race is the desired state arriving from somewhere else.
    // Read it back rather than trusting the conflict's body, so what returns is
    // a project this function actually saw.
    if (!created.ok && created.kind === 'status' && created.status === 409) {
      const after = unwrap(
        await http.json<Envelope<PagesProject>>({
          method: 'GET',
          path: this.projectPath(connection, project),
        }),
      );
      if (after.ok && after.value !== undefined) {
        return { ok: true, value: after.value };
      }
      return { ok: false, failure: created };
    }
    const made = unwrap(created);
    if (!made.ok) return made;
    return { ok: true, value: made.value ?? {} };
  }

  /**
   * One deployment, from the manifest the upload produced.
   *
   * Multipart because that is what the endpoint takes, and the `branch` field
   * is what decides this is the live site rather than a preview — a deployment
   * on any other branch succeeds, answers with a URL, and serves nowhere the
   * canonical name points.
   */
  private async deploy(
    http: CloudHttp,
    connection: CloudflarePagesAdapterConnection,
    project: string,
    branch: string,
    desired: DesiredState,
    manifest: AssetManifest,
  ): Promise<Outcome<PagesDeployment>> {
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('branch', branch);
    // The one field on a deployment that takes free text and comes back on a
    // read. See the file header: this is where the digest lives, because there
    // is nowhere else to put it.
    form.append(
      'commit_message',
      `${DIGEST_MARKER}${desired.artifact.digest} ${DEPLOY_MARKER}${desired.deploy}`,
    );

    const created = unwrap(
      await http.form<Envelope<PagesDeployment>>({
        path: `${this.projectPath(connection, project)}/deployments`,
        body: form,
      }),
    );
    if (!created.ok) return created;
    if (created.value === undefined) {
      return { ok: false, failure: missing('the API created no deployment') };
    }
    return { ok: true, value: created.value };
  }

  /** Put the vanity name on this project (§9). An existing one is not an error. */
  private async attachDomain(
    http: CloudHttp,
    connection: CloudflarePagesAdapterConnection,
    project: string,
    domain: string,
  ): Promise<Outcome<void>> {
    const attached = await http.json<Envelope<unknown>>({
      method: 'POST',
      path: `${this.projectPath(connection, project)}/domains`,
      body: { name: domain },
    });
    if (attached.ok) return { ok: true, value: undefined };
    // The name is already on this project, which is the state being asked for.
    if (attached.kind === 'status' && attached.status === 409) {
      return { ok: true, value: undefined };
    }
    return { ok: false, failure: attached };
  }

  // --- inspect's second half -----------------------------------------------

  private discover(
    connection: CloudflarePagesAdapterConnection,
  ): TargetDiscovery {
    return {
      // Files are served, not run. An empty `arch` excludes no Target on
      // architecture, which is right: there is nothing here for an architecture
      // to be wrong about.
      arch: [],
      gpu: false,
      resourceCeiling: {},
      persistence: false,
      postgres: false,
      valkey: false,
      egressFiltering: false,
      // §16's verifiers check images at admission. Nothing is admitted here —
      // there is no image and no runtime — so reporting an engine would make
      // `verifiedDeploy` true of a Target that verifies nothing.
      policyEngine: { installed: false, mode: null },
      // §17: static hosting gets an **honest empty state** rather than a
      // duration. Zero is that — no process ever wrote a line.
      logHistorySeconds: 0,
      servedHosts: connection.servedHosts ?? [],
      // Nothing is pulled: the files were uploaded, and the platform holds them.
      reachableRegistries: [],
      // §10's reach rule from the other side: a site has no runtime to resolve
      // a reference with, so it reaches no store — which is why §10's website
      // exception exists.
      reachableSecretStores: [] as readonly StoreAdapter[],
    };
  }

  // --- plumbing ------------------------------------------------------------

  /** The one form of a project's resource name every call above hangs off. */
  private projectPath(
    connection: CloudflarePagesAdapterConnection,
    project: string,
  ): string {
    return `/accounts/${encodeURIComponent(connection.account)}/pages/projects/${encodeURIComponent(project)}`;
  }

  private http(connection: CloudflarePagesAdapterConnection): CloudHttp {
    return new CloudHttp({
      baseUrl: connection.endpoint,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private connectionOf(
    target: DeployTarget,
  ): CloudflarePagesAdapterConnection | null {
    return target.connection.adapter === 'cloudflare-pages'
      ? target.connection
      : null;
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
}

/**
 * §13's checklist, as this Target answers it.
 *
 * The same three rows the other tokened backend is assessed against, and the
 * middle one is why they match: `API_TOKEN` is `OIDC_FEDERATION`'s counterpart
 * where there is no federation to check, so a Cloudflare Target reading
 * `OIDC_FEDERATION: unmet` would send an operator to configure a trust
 * relationship that does not exist on either side.
 *
 * One call answers all three, for the reason `cloud/checklist.ts` gives:
 * separate probes are separate chances to be rate-limited and separate answers
 * that can disagree.
 *
 * | The probe said | Unmet | Because |
 * | --- | --- | --- |
 * | `200` | — | the API answered, the token may act, and the account exists |
 * | `401`/`403` | `API_TOKEN` | the bearer is refused, or is not scoped to Pages |
 * | `404` | `VESSEL` | there is no such account |
 * | anything else | all three | nothing was established, and saying so beats guessing |
 */
export function pagesChecklist(
  probe: CloudResponse<unknown>,
  account: string,
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
      // It answered, which is more than an unreachable API does.
      { name: 'PLATFORM_API', met: true },
      {
        name: 'API_TOKEN',
        met: false,
        assessed: true,
        detail: `this installation's ${SERVICE_NAME} token may not act on ${account}: ${probe.message}`,
      },
      // Not assessed rather than met: an account that refuses to answer has not
      // told us it exists, and a refusal is what an absent one looks like from
      // outside.
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
        detail: `the account ${account} does not exist, and Spindrift never creates a vessel (§14)`,
      },
    ];
  }
  return allUnmet(`${SERVICE_NAME} answered ${probe.status}: ${probe.message}`);
}

/**
 * Whether that same probe established the account carries this surface.
 *
 * Never `absent`, and that is the honest answer rather than a gap: Pages is not
 * a per-account switch that can be off, so no refusal means "this account does
 * not do static hosting". An account that answers carries it; one that does not
 * has established nothing, and reading a refusal as an absence would delete a
 * Target over an expired token.
 */
export function pagesSurfaceProbe(
  probe: CloudResponse<unknown>,
  account: string,
): SurfaceProbe {
  if (probe.ok) return { kind: 'carried' };
  return {
    kind: 'undetermined',
    detail:
      probe.kind === 'transport'
        ? `${SERVICE_NAME} could not be reached: ${probe.message}`
        : `${SERVICE_NAME} answered ${probe.status} for ${account}: ${probe.message}`,
  };
}

/** Every row unmet with one sentence — the Target nothing is known about. */
function allUnmet(detail: string): readonly PrerequisiteResult[] {
  return (['PLATFORM_API', 'API_TOKEN', 'VESSEL'] as const).map((name) => ({
    name,
    met: false,
    assessed: false,
    detail,
  }));
}

/** A row the probe did not get far enough to reach a verdict on. */
function notAssessed(): { met: false; assessed: false; detail: string } {
  return {
    met: false,
    assessed: false,
    detail: `not assessed: the ${SERVICE_NAME} probe did not get far enough to check this`,
  };
}

/** The artifact was addressed and the bytes were not there (§6's platform blame). */
class ArtifactUnavailable extends Error {
  override readonly name = 'ArtifactUnavailable';
}

/**
 * One project per (App, Component), within what the platform allows.
 *
 * Lowercased because a project name is a DNS label on the platform's own
 * subdomain, and `workloadName` is fed an App and a Component that core does
 * not case-fold.
 */
export function projectName(desired: DesiredState): string {
  return workloadName(desired, PROJECT_NAME_LIMIT).toLowerCase();
}

/** The adapter's own handle on what `apply` placed — opaque to core (§6). */
function refOf(
  connection: CloudflarePagesAdapterConnection,
  project: string,
): DeployRef {
  return `${connection.account}/pages/${project}`;
}

/** The project this ref names on this connection, or `null` for another's. */
function parseRef(
  connection: CloudflarePagesAdapterConnection,
  ref: DeployRef,
): string | null {
  const prefix = `${connection.account}/pages/`;
  if (!ref.startsWith(prefix)) return null;
  const project = ref.slice(prefix.length);
  return project.length === 0 || project.includes('/') ? null : project;
}

/**
 * §6's phase, from the stage the platform reports.
 *
 * A direct upload has no build to watch, so the interesting states are few: the
 * deploy stage having succeeded is `LIVE`, any stage having failed or been
 * cancelled is `FAILED`, and everything else is still on its way. `WAITING`
 * rather than `APPLYING` for the in-between, because the bytes are already
 * there and what remains is the platform's own propagation.
 */
function phaseOf(deployment: PagesDeployment): DeployPhase {
  const status = deployment.latest_stage?.status;
  if (status === 'failure' || status === 'canceled') return 'FAILED';
  if (deployment.latest_stage?.name === 'deploy' && status === 'success') {
    return 'LIVE';
  }
  return 'WAITING';
}

/** One marker's value out of the commit message, or `''` where there is none. */
function markerIn(message: string | undefined, marker: string): string {
  const found = (message ?? '')
    .split(/\s+/)
    .find((word) => word.startsWith(marker));
  return found === undefined ? '' : found.slice(marker.length);
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
    // The bytes arrived and are not what a `files` artifact is. That is the
    // build having produced something unusable, which §6 blames on the
    // developer under `BUILD_FAILED`.
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

/** Re-exported so a caller need not know which file the refusal shape lives in. */
export type { CloudFailure };
