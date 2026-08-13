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
import {
  type AssetManifest,
  type Envelope,
  hashFiles,
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
  /**
   * What authorizes reading the artifact, which is not the same far side.
   *
   * The bytes live in the installation's artifacts registry (§14), so this is
   * the federated cloud token every other adapter already holds — the same
   * split the Vercel backend makes, and for the same reason: it keeps a
   * Cloudflare bearer from being sent to a registry and a cloud token from
   * being sent to Cloudflare.
   */
  readonly artifactToken: TokenProvider;
  /**
   * How this installation signs for an object in its source depot, or `null`
   * where it configured none.
   *
   * Not a second account credential: a supplied upload was never built, so its
   * bytes are a `gs://` object rather than a URL, and reading one takes a V4
   * signature rather than any bearer this backend holds. `storage/signed-url.ts`
   * is where that exchange and its one grant are written down.
   */
  readonly federation?: FederationOptions | null;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  readonly now?: () => number;
}

/** How the operator would name the product in a sentence about enabling it. */
const SERVICE_NAME = 'Cloudflare Pages';

/**
 * The platform's own API root — one hostname for every account, because
 * Cloudflare runs a single control plane rather than one per customer.
 * `CloudflarePagesConnection.endpoint` used to be required and typed into the
 * connect form on the theory that it was connection material the way a
 * cluster's `apiServer` is; it never varied between installations, so this is
 * now the default applied wherever `connection.endpoint` is read, with the
 * Target's own value kept only as an override for a perimeter or a mirror in
 * front of the real API.
 */
export const DEFAULT_ENDPOINT = 'https://api.cloudflare.com/client/v4';

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

    // Same choice the other files backends make — literally, via the same
    // predicate — with two identities doing the reading: a staged address is a
    // supplied upload's own and is fetched as such (a `gs://` object is not a
    // URL, but a signature turns it into one), and among registry references
    // only one in the installation's Google-family artifacts registry is
    // readable, with the federated token this adapter is handed for exactly
    // that. The account credential is for this platform and authorizes nothing
    // at a registry, which is why the registry arm is a second token rather
    // than the deploy one reused.
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

    const ensured = await this.ensureProject(http, connection, project);
    if (ensured.ok === false) {
      const failure = cloudWriteFailure(ensured.failure, ref);
      yield this.events.status('FAILED', {
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
    yield this.events.log(`deployed ${released.value.id ?? project}`, project);

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

    // The deployment's own address is one deployment's; the project's subdomain
    // is what the production branch always answers on. §9 wants the canonical,
    // which is the second — the first changes every release.
    const address =
      ensured.value.subdomain === undefined
        ? released.value.url
        : `https://${ensured.value.subdomain}`;
    yield this.events.status('LIVE', { resource: project });
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
    // What is fetched and what is *named* part company here on purpose: a
    // signed URL is a bearer capability, so both sentences below name the
    // address the artifact carries and never the one minted from it.
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
        // §6 blames the **platform** for an artifact that cannot be fetched,
        // and this is exactly that: the build is green and the bytes are not
        // there.
        throw new ArtifactUnavailable(
          `the artifact at ${location} could not be fetched: ${fetched.message}`,
        );
      }
      return readBundle(fetched.value);
    }
    // Anything else is a registry reference — the shape every built artifact's
    // ref has — and the bytes are the artifact's one layer, read with the
    // federated identity rather than the account credential.
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

  /** The API root this Target actually reaches, override or default. */
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
  return tokenChecklist(probe, subjectOf(account));
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
  return tokenSurfaceProbe(probe, subjectOf(account));
}

/** What both answers above are said about — the product and the boundary. */
function subjectOf(account: string): TokenChecklistSubject {
  return { service: SERVICE_NAME, vessel: account, noun: 'account' };
}

/**
 * Why nothing here can be fetched, said about the address that failed.
 *
 * The three cases the other files backends distinguish, worded for this one: no
 * address at all, a bundle staged somewhere nothing outside one process
 * reaches, and a built artifact homed only on a registry this identity cannot
 * read. Telling the middle one apart is the point — it used to take the
 * registry sentence, which sends an operator to a credential problem over a
 * bundle sitting on a disk.
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
  return scopedRef(connection.account, 'pages', project);
}

/** The project this ref names on this connection, or `null` for another's. */
function parseRef(
  connection: CloudflarePagesAdapterConnection,
  ref: DeployRef,
): string | null {
  return parseScopedRef(connection.account, 'pages', ref);
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

/** Re-exported so a caller need not know which file the refusal shape lives in. */
export type { CloudFailure };
