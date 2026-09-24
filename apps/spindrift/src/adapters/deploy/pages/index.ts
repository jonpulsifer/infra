/**
 * The Cloudflare Pages deploy adapter, for public `files` sites. The platform
 * federates no identity, so its account token comes from the environment, and a
 * deployment takes no labels, so the digest and Deploy ride its commit message.
 */

import { type BundleFile, readBundle } from '@repo/archive/bundle';
import type { FederationOptions } from '@repo/archive/federation';
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
  type CloudflarePagesAdapterConnection,
  targetLabel,
} from '../../../domain/target.ts';
import type { SurfaceProbe } from '../../../domain/vessel.ts';
import { workloadName } from '../../../domain/workload-name.ts';
import { fetchableBundleUrl } from '../../../storage/signed-url.ts';
import { CLOUDFLARE_API_ROOT } from '../../cloudflare.ts';
import {
  type TokenChecklistSubject,
  tokenChecklist,
  tokenSurfaceProbe,
} from '../cloud/checklist.ts';
import {
  CloudHttp,
  type CloudResponse,
  type Fetcher,
  type TokenProvider,
} from '../cloud/http.ts';
import {
  type CloudFailure,
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
  Restarted,
  RuntimeLogPage,
  RuntimeLogSubject,
  StartedRun,
} from '../contract.ts';
import { type DeployEvents, deployEvents, internalFailure } from '../events.ts';
import { parseScopedRef, scopedRef } from '../ref.ts';
import { ArtifactUnavailable, bundleFailure } from '../static/bundle.ts';
import { fetchableStagedAddress, STAGED_SCHEME } from '../static/index.ts';
import {
  googleRegistryRef,
  OciPullError,
  pullFilesLayer,
} from '../static/oci.ts';
import {
  type AssetManifest,
  type Envelope,
  hashFiles,
  unwrap,
  uploadAssets,
} from './assets.ts';

export interface PagesAdapterOptions {
  /** Mints the account credential per call. */
  readonly token: TokenProvider;
  /**
   * The federated cloud token for the artifact registry, kept apart so neither
   * credential is ever sent to the other's far side.
   */
  readonly artifactToken: TokenProvider;
  /**
   * Signs a short-lived URL for a supplied upload's `gs://` object, or `null`
   * where none is configured.
   */
  readonly federation?: FederationOptions | null;
  readonly fetch?: Fetcher;
  readonly now?: () => number;
}

/** The product's name in a sentence about enabling it. */
const SERVICE_NAME = 'Cloudflare Pages';

/** The account-wide API root; a Target's `endpoint` overrides it. */
export const DEFAULT_ENDPOINT = CLOUDFLARE_API_ROOT;

/**
 * The branch a new project is created with. An existing project keeps its own;
 * see {@link PagesDeployAdapter.ensureProject}.
 */
const PRODUCTION_BRANCH = 'production';

/** The platform's cap on a project name. */
const PROJECT_NAME_LIMIT = 58;

/** Where the digest and the deploy travel, since a deployment carries no labels. */
const DIGEST_MARKER = 'spindrift-digest=';
const DEPLOY_MARKER = 'spindrift-deploy=';

const NOTHING_RUNS = 'Static files are served by the Target.';

interface PagesProject {
  readonly name?: string;
  readonly subdomain?: string;
  readonly production_branch?: string;
}

/**
 * The `*_data` blocks hold Cloudflare's reason when issuance fails; the
 * envelope's `errors` is empty for a domain that failed validation.
 */
interface PagesDomain {
  readonly name?: string;
  readonly status?: string;
  readonly validation_data?: { readonly error_message?: string };
  readonly verification_data?: { readonly error_message?: string };
}

export interface PagesDomainState {
  /** Serving now, not merely accepted. */
  readonly serving: boolean;
  /** Cloudflare's own word for it, for the deploy log. */
  readonly status: string;
}

/**
 * Statuses that turn `active` on their own once the certificate issues. Any
 * other status but `active`, including one Cloudflare adds later, is a refusal.
 */
const SETTLING = ['initializing', 'pending'] as const;

function domainState(
  unwrapped: Outcome<PagesDomain | undefined>,
): Outcome<PagesDomainState> {
  if (!unwrapped.ok) return unwrapped;
  const status = unwrapped.value?.status ?? 'unknown';
  if (status === 'active')
    return { ok: true, value: { serving: true, status } };
  if (SETTLING.some((settling) => settling === status)) {
    return { ok: true, value: { serving: false, status } };
  }
  const said =
    unwrapped.value?.validation_data?.error_message ??
    unwrapped.value?.verification_data?.error_message ??
    'Cloudflare gave no reason.';
  return {
    ok: false,
    failure: {
      ok: false,
      kind: 'transport',
      message: `the custom domain is ${status}: ${said}`,
    },
  };
}

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
  readonly artifactTypes: readonly ArtifactType[] = ['files'];

  private readonly events: DeployEvents;

  constructor(private readonly options: PagesAdapterOptions) {
    this.events = deployEvents(options.now);
  }

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return internalFailure('this Target is not a Cloudflare Pages Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        `Cloudflare Pages does not accept a ${desired.artifact.type} artifact`,
      );
    }
    if (desired.reach !== 'public') {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        `Cloudflare Pages serves a public reach only, and this Component asks for ${desired.reach} (§9)`,
      );
    }
    if (desired.auth === 'proxy') {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        'Cloudflare Pages has no authenticated edge to put in front of a Component (§9)',
      );
    }

    // The account credential authorizes nothing at a registry, so the registry
    // arm reads with the federated token.
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

    const ensured = await this.ensureProject(http, connection, project);
    if (ensured.ok === false) {
      const failure = cloudWriteFailure(ensured.failure, ref);
      yield this.events.status('FAILED', {
        resource: project,
        reason: failure.reason,
      });
      return failure;
    }

    // Every create is a new production deployment, so a re-run adopts the one
    // this Deploy already made unless it failed. Read-then-create is not atomic.
    const existing = await this.findDeployment(
      http,
      connection,
      project,
      desired.deploy,
    );
    let deployment: PagesDeployment;
    if (existing !== null && phaseOf(existing) !== 'FAILED') {
      yield this.events.log(
        `deployment ${existing.id ?? project} already carries this Deploy — adopting it instead of creating another`,
        project,
      );
      deployment = existing;
    } else {
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

      // A generator cannot yield from inside the progress callback.
      const lines: string[] = [];
      const uploaded = await uploadAssets({
        client: http,
        account: connection.account,
        endpoint: this.endpointOf(connection),
        ...(this.options.fetch === undefined
          ? {}
          : { fetch: this.options.fetch }),
        project,
        files: hashFiles(files),
        onProgress: (line) => lines.push(line),
      });
      for (const line of lines) yield this.events.log(line, project);
      if (uploaded.ok === false) {
        const failure = cloudWriteFailure(uploaded.failure, ref);
        yield this.events.status('FAILED', {
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
        yield this.events.status('FAILED', {
          resource: project,
          reason: failure.reason,
        });
        return failure;
      }
      deployment = released.value;
      yield this.events.log(`deployed ${deployment.id ?? project}`, project);
    }

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
        attached.value.serving
          ? `${desired.hostname.vanity} is serving on this project`
          : `${desired.hostname.vanity} is attached and ${attached.value.status} — Cloudflare is issuing its certificate, and it does not answer until that lands`,
        project,
      );
    }

    // Production always answers on the project's subdomain; a deployment's own
    // address changes every release.
    const address =
      ensured.value.subdomain === undefined
        ? deployment.url
        : `https://${ensured.value.subdomain}`;
    yield this.events.status('LIVE', { resource: project });
    return {
      phase: 'LIVE',
      ref,
      ...(address === undefined ? {} : { url: address }),
      // `attachDomain` only lets the name serve here. The deploy loop publishes
      // the record, which must target the project, not one deployment.
      ...(ensured.value.subdomain === undefined
        ? {}
        : {
            address: {
              recordType: 'CNAME',
              target: ensured.value.subdomain,
              proxied: true,
            },
          }),
    };
  }

  /**
   * What the latest deployment serves. The digest rides the commit message, so a
   * deployment made elsewhere reports an empty digest and shows as drift.
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

    // The DELETE's status is not trusted; the read-back decides.
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
   * A Pages Target runs no jobs, so placement never sends one here. It still
   * refuses in a sentence, for a caller that skips the kind check.
   */
  async run(_target: DeployTarget, _ref: DeployRef): Promise<StartedRun> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  async restart(_target: DeployTarget, _ref: DeployRef): Promise<Restarted> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  async executions(_target: DeployTarget, _ref: DeployRef): Promise<JobRuns> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  /** The checklist, discovery and surface, from one probe. */
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

  /** Fetch the staged bundle and read it into files. Throws; `apply` catches. */
  private async fetchBundle(
    http: CloudHttp,
    location: string,
  ): Promise<readonly BundleFile[]> {
    // Errors name `location`, never the signed URL, which is a bearer capability.
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
    // Anything else is a registry ref, and the bytes are its one layer.
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
   * The deployment an earlier attempt of this Deploy created, found by
   * {@link DEPLOY_MARKER} on the first page. `null` also when the read is
   * refused, so a flaky list never blocks a deploy.
   */
  private async findDeployment(
    http: CloudHttp,
    connection: CloudflarePagesAdapterConnection,
    project: string,
    deploy: string,
  ): Promise<PagesDeployment | null> {
    const listed = unwrap(
      await http.json<Envelope<readonly PagesDeployment[]>>({
        method: 'GET',
        path: `${this.projectPath(connection, project)}/deployments`,
        query: { per_page: '25' },
      }),
    );
    if (!listed.ok || listed.value === undefined) return null;
    return (
      listed.value.find(
        (deployment) =>
          markerIn(
            deployment.deployment_trigger?.metadata?.commit_message,
            DEPLOY_MARKER,
          ) === deploy,
      ) ?? null
    );
  }

  /**
   * The project, created only if absent. An existing project comes back with
   * its own production branch.
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
    // A 409 is a lost create race; read the project back instead of trusting
    // the conflict's body.
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
   * One deployment from the uploaded manifest. Only the production `branch`
   * serves the canonical name; any other branch makes a preview.
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
    // The one free-text field that comes back on a read.
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

  /**
   * Adds the vanity name and reports its status. A 200 does not mean it serves:
   * a first attach is `initializing` until the certificate issues, which takes
   * no published time, so the deploy does not wait for it.
   */
  private async attachDomain(
    http: CloudHttp,
    connection: CloudflarePagesAdapterConnection,
    project: string,
    domain: string,
  ): Promise<Outcome<PagesDomainState>> {
    const attached = await http.json<Envelope<PagesDomain>>({
      method: 'POST',
      path: `${this.projectPath(connection, project)}/domains`,
      body: { name: domain },
    });
    if (attached.ok) return domainState(unwrap(attached));
    // The duplicate refusal's status is undocumented, so a read decides: a name
    // already here reports its state, and only an absent one keeps the error.
    const read = await http.json<Envelope<PagesDomain>>({
      method: 'GET',
      path: `${this.projectPath(connection, project)}/domains/${encodeURIComponent(domain)}`,
    });
    return read.ok
      ? domainState(unwrap(read))
      : { ok: false, failure: attached };
  }

  private discover(
    connection: CloudflarePagesAdapterConnection,
  ): TargetDiscovery {
    return {
      // An empty `arch` excludes no Target on architecture.
      arch: [],
      gpu: false,
      resourceCeiling: {},
      persistence: false,
      postgres: false,
      valkey: false,
      egressFiltering: false,
      // No image is admitted here, and an engine would make `verifiedDeploy`
      // true of a Target that verifies nothing.
      policyEngine: { installed: false, mode: null },
      // No process ever writes a line here.
      logHistorySeconds: 0,
      servedHosts: connection.servedHosts ?? [],
      // Nothing is pulled: the files were uploaded, and the platform holds them.
      reachableRegistries: [],
      // A site has no runtime to resolve a secret reference with.
      reachableSecretStores: [] as readonly StoreAdapter[],
    };
  }

  private projectPath(
    connection: CloudflarePagesAdapterConnection,
    project: string,
  ): string {
    return `/accounts/${encodeURIComponent(connection.account)}/pages/projects/${encodeURIComponent(project)}`;
  }

  private endpointOf(connection: CloudflarePagesAdapterConnection): string {
    return connection.endpoint ?? DEFAULT_ENDPOINT;
  }

  private http(connection: CloudflarePagesAdapterConnection): CloudHttp {
    return new CloudHttp({
      baseUrl: this.endpointOf(connection),
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
}

/**
 * The prerequisite checklist from one probe. `API_TOKEN` stands in for
 * `OIDC_FEDERATION`, since the platform has no federation to check.
 */
export function pagesChecklist(
  probe: CloudResponse<unknown>,
  account: string,
): readonly PrerequisiteResult[] {
  return tokenChecklist(probe, subjectOf(account));
}

/**
 * Whether the probe shows the account carries Pages. Never `absent`: Pages
 * cannot be switched off, and a refusal is not an absence.
 */
export function pagesSurfaceProbe(
  probe: CloudResponse<unknown>,
  account: string,
): SurfaceProbe {
  return tokenSurfaceProbe(probe, subjectOf(account));
}

function subjectOf(account: string): TokenChecklistSubject {
  return { service: SERVICE_NAME, vessel: account, noun: 'account' };
}

/**
 * Why nothing can be fetched: no address, a bundle on one installation's own
 * disk, or only registries this identity cannot read.
 */
function unfetchableArtifact(
  artifact: Artifact,
  staged: string | null,
): string {
  if (artifact.refs.length === 0) {
    return 'the artifact carries no address to fetch it from';
  }
  if (staged !== null && STAGED_SCHEME.test(staged)) {
    return `the artifact is staged at ${staged}, which names this installation's own disk rather than an address Cloudflare Pages can fetch`;
  }
  const hosts = artifact.refs.map((ref) => ref.split('/')[0]).join(', ');
  return `Cloudflare Pages is fed the bytes, and none of the artifact's homes (${hosts}) is a registry this installation's identity can read`;
}

/**
 * One project per (App, Component), lowercased because the name is a DNS label
 * under the platform's own subdomain.
 */
export function projectName(desired: DesiredState): string {
  return workloadName(desired, PROJECT_NAME_LIMIT).toLowerCase();
}

function refOf(
  connection: CloudflarePagesAdapterConnection,
  project: string,
): DeployRef {
  return scopedRef(connection.account, 'pages', project);
}

function parseRef(
  connection: CloudflarePagesAdapterConnection,
  ref: DeployRef,
): string | null {
  return parseScopedRef(connection.account, 'pages', ref);
}

/**
 * Neither failed nor deployed is `WAITING`, not `APPLYING`: the bytes are
 * uploaded, and only the platform's own propagation remains.
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

export type { CloudFailure };
