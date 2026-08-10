/**
 * The static-hosting deploy adapter (§6, §9).
 *
 * Accepts `files`, talks to the hosting product's API directly, and reads status
 * from the release the API returns. There is no rollout to watch: a release is
 * atomic and synchronous, so §6's `WAITING` phase is a state this backend never
 * occupies — which is the honest reason this adapter does not poll, rather than
 * a corner cut.
 *
 * **`Public` only** (§9). "No non-public mode may have a bypassable origin. A
 * rendering that leaves an unauthenticated alternate origin is **disqualified
 * rather than shipped with a caveat** — which is why the static hosting product
 * serves `Public` only, and why a Private website takes the server-image
 * rendering." The origin here is the site's own address, which the product will
 * always answer on; no authenticated edge can be put in front of it that the
 * origin does not bypass. So a non-public exposure reaching `apply` is refused,
 * and refused as `INTERNAL` rather than `REJECTED`: this adapter asserts
 * `['public']` and nothing else (`ASSERTED_REACHES_BY_ADAPTER` in
 * `domain/capabilities.ts`), so placement excludes it for a non-public
 * Component by the ordinary reach join — `REACH_UNSUPPORTED`, not a special
 * case. One arriving here is therefore core's bug and not a developer's.
 *
 * **The site names itself** (§9). The product mints the address, so the
 * canonical name comes back across this seam on the verdict rather than being
 * handed in — and the vanity name is added to the same site as a domain, which
 * is what makes "moving an App between backends is one record re-point" true
 * for this backend.
 */
import type {
  StoreAdapter,
  TargetAdapter,
} from '../../../config/manifest.schema.ts';
import type {
  TargetDiscovery,
  TargetInspection,
} from '../../../domain/capabilities.ts';
import {
  type ArtifactType,
  artifactAddress,
  type DesiredState,
} from '../../../domain/desired-state.ts';
import {
  type StaticAdapterConnection,
  targetLabel,
} from '../../../domain/target.ts';
import { workloadName } from '../../../domain/workload-name.ts';
import { cloudChecklist, cloudSurfaceProbe } from '../cloud/checklist.ts';
import { CloudHttp, type Fetcher, type TokenProvider } from '../cloud/http.ts';
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
import { BundleError, type BundleFile, readBundle } from './bundle.ts';
import { googleRegistryRef, OciPullError, pullFilesLayer } from './oci.ts';

export interface StaticAdapterOptions {
  /** Mints a bearer token per request. Never a stored credential (§13). */
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  readonly now?: () => number;
}

/** How the operator would name the product in the sentence about enabling it. */
const SERVICE_NAME = 'static hosting';

/** The API version every call below hangs off. */
const API_VERSION = '/v1beta1';

/** The label a version carries so `observe` can report what is serving. */
const DIGEST_LABEL = 'spindrift-digest';
const DEPLOY_LABEL = 'spindrift-deploy';

/** A site id is capped well below a DNS label. See `domain/workload-name.ts`. */
const SITE_ID_LIMIT = 30;

/**
 * The one sentence every runtime question here is answered with (§17).
 *
 * Three questions — what is it saying, run it, what has it run — and one fact
 * behind all three: files are served, never executed. Written once so the three
 * refusals cannot drift into three different explanations of the same thing.
 */
const NOTHING_RUNS = 'Static files are served by the Target.';

/**
 * The most file hashes one `populateFiles` call may carry.
 *
 * The API's own ceiling, not a tuning knob: "You can send a maximum of 1000
 * file hashes in each API request. To list all the files for the version, you
 * can call this endpoint multiple times; the files in each call will be added
 * to the version." A built site clears that without trying — one hashed asset
 * directory is enough — so the offer is made in chunks and every chunk's
 * answer is kept. Anything less deploys a version whose bytes are not all
 * there, which finalizes happily and serves a broken site.
 */
const POPULATE_LIMIT = 1000;

/** What a version looks like coming back, as much as this adapter reads. */
interface HostingVersion {
  readonly name?: string;
  readonly status?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/** What `populateFiles` answers: which of the offered hashes it wants. */
interface PopulateResult {
  readonly uploadRequiredHashes?: readonly string[];
  readonly uploadUrl?: string;
}

/** One release, as much of it as this adapter reads. */
interface HostingRelease {
  readonly name?: string;
  readonly version?: HostingVersion;
}

/** One site, as much of it as this adapter reads. */
interface HostingSite {
  readonly name?: string;
  readonly defaultUrl?: string;
}

export class StaticDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter = 'static';
  /** §6's table: `static` takes files. */
  readonly artifactTypes: readonly ArtifactType[] = ['files'];

  constructor(private readonly options: StaticAdapterOptions) {}

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return this.internal('this Target is not a static hosting Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        `static hosting does not accept a ${desired.artifact.type} artifact`,
      );
    }
    if (desired.reach !== 'public') {
      // §9, and see the file header: this backend has no non-bypassable origin
      // to put a boundary in front of, so the rendering is disqualified rather
      // than shipped with a caveat.
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        `static hosting serves a public reach only, and this Component asks for ${desired.reach} (§9)`,
      );
    }
    if (desired.auth === 'proxy') {
      // Same shape, other axis: there is no edge here to authenticate at, so
      // claiming one would be the caveat this backend refuses to ship with.
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        'static hosting has no authenticated edge to put in front of a Component (§9)',
      );
    }
    // No registry filter: a static Target serves `files`, and the reachability
    // §3 models over registries is about a *runtime* pulling an image. This
    // adapter is the one that pulls for itself, so the choice here is by what
    // its own identity can read: a staged URL is fetched directly (a supplied
    // upload's address), and among registry references only a Google-family
    // one is readable with the federated token this adapter already holds —
    // `ghcr.io` would take a credential the manifest deliberately does not
    // model (§13).
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
            : `static hosting fetches the bytes itself, and none of the artifact's homes (${hosts}) is a registry its identity can read`,
      };
    }

    const site = siteId(desired);
    const ref = refOf(connection, site);
    const http = this.http(connection);

    yield this.status('APPLYING', { resource: site });

    let files: readonly BundleFile[];
    try {
      files = await this.fetchBundle(http, location);
    } catch (cause) {
      const failure = bundleFailure(cause, ref);
      yield this.status('FAILED', { resource: site, reason: failure.reason });
      return failure;
    }
    yield this.log(`the bundle holds ${files.length} files`, site);

    const created = await this.ensureSite(http, connection, site);
    if (created.ok === false) {
      const failure = cloudWriteFailure(created.failure, ref);
      yield this.status('FAILED', { resource: site, reason: failure.reason });
      return failure;
    }

    const released = await this.release(http, site, desired, files);
    if (released.ok === false) {
      const failure = cloudWriteFailure(released.failure, ref);
      yield this.status('FAILED', { resource: site, reason: failure.reason });
      return failure;
    }
    yield this.log(`released ${released.value}`, site);

    // §9's one record re-point, made real for this backend: the vanity name is
    // a domain on the site that is already serving, so moving an App here from
    // another backend moves one name rather than rebuilding a leg.
    if (desired.hostname.vanity !== undefined) {
      const attached = await this.attachDomain(
        http,
        site,
        desired.hostname.vanity,
      );
      if (attached.ok === false) {
        const failure = cloudWriteFailure(attached.failure, ref);
        yield this.status('FAILED', { resource: site, reason: failure.reason });
        return failure;
      }
      yield this.log(
        `the vanity name ${desired.hostname.vanity} is on this site`,
        site,
      );
    }

    const address = created.value.defaultUrl;
    yield this.status('LIVE', { resource: site });
    return {
      phase: 'LIVE',
      ref,
      // §9: the platform names its own. A site with no reported address is the
      // one case core cannot fill in, and saying nothing beats assembling a
      // name the product did not give.
      ...(address === undefined ? {} : { url: address }),
    };
  }

  /**
   * What is serving, read from the release rather than from what was written.
   *
   * The digest comes off the released version's labels, which is the only place
   * it can come from: the product stores files and has no notion of an artifact.
   * A version released by something other than Spindrift therefore reports an
   * empty digest and shows as drift — which is right, because it is.
   */
  async observe(
    target: DeployTarget,
    ref: DeployRef,
  ): Promise<ObservedState | null> {
    const connection = this.connectionOf(target);
    if (connection === null) return null;
    const site = parseRef(connection, ref);
    if (site === null) return null;

    const releases = await this.http(connection).json<{
      releases?: readonly HostingRelease[];
    }>({
      method: 'GET',
      path: `${API_VERSION}/sites/${encodeURIComponent(site)}/releases`,
      query: { pageSize: '1' },
    });
    if (!releases.ok) return null;

    const latest = releases.value?.releases?.[0];
    if (latest === undefined) return null;

    return {
      ref,
      phase: 'LIVE',
      artifactDigest: latest.version?.labels?.[DIGEST_LABEL] ?? '',
    };
  }

  async destroy(target: DeployTarget, ref: DeployRef): Promise<void> {
    const connection = this.connectionOf(target);
    if (connection === null) return;
    const site = parseRef(connection, ref);
    if (site === null) return;

    const http = this.http(connection);
    const deletion = await http.json<unknown>({
      method: 'DELETE',
      path: `${API_VERSION}/projects/${encodeURIComponent(connection.project)}/sites/${encodeURIComponent(site)}`,
    });

    // The DELETE's own status is not trusted either way: a 404 means both
    // "already gone" and "this call hit a path the API does not serve". Read
    // the site back instead — absent is destroyed, present is a destroy that
    // did not happen and must not be reported as one.
    //
    // The read is project-scoped for the same reason the DELETE above is. A
    // read of the flat `sites/{site}` answers 404 unconditionally, which
    // makes this check pass unconditionally — the exact blindness it exists
    // to end, reintroduced one line below the comment describing it.
    const read = await http.json<HostingSite>({
      method: 'GET',
      path: this.sitePath(connection, site),
    });
    if (!read.ok && read.kind === 'status' && read.status === 404) return;
    throw new Error(
      read.ok
        ? `site ${site} still exists after destroy${
            deletion.ok
              ? ''
              : ` (delete answered ${
                  deletion.kind === 'status'
                    ? `${deletion.status}: ${deletion.message}`
                    : deletion.message
                })`
          }`
        : `could not verify site ${site} was destroyed: ${
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
    return {
      kind: 'none',
      because: NOTHING_RUNS,
    };
  }

  /**
   * There is nothing here to run, and saying so is the answer (§17).
   *
   * `KINDS_BY_ADAPTER.static` is `['website']`, so a job never reaches this
   * backend and this refusal is unreachable through placement. It is written
   * anyway, and written as a refusal rather than left unimplemented, for the
   * same reason `tail` returns its `none` arm rather than an empty page: a
   * contract every adapter answers is a contract core can call without asking
   * which one it is holding, and a method that threw would make the one caller
   * that forgot to check the kind fail as a crash instead of as a sentence.
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
      throw new Error(`${targetLabel(target)} is not a static hosting Target`);
    }

    const probe = await this.http(connection).json<unknown>({
      method: 'GET',
      path: `${API_VERSION}/projects/${encodeURIComponent(connection.project)}/sites`,
      query: { pageSize: '1' },
    });
    const subject = {
      project: connection.project,
      service: SERVICE_NAME,
      scope: connection.project,
    };

    return {
      prerequisites: orderedChecklist(
        cloudChecklist(probe, subject),
        this.adapter,
      ),
      discovery: this.discover(connection),
      surface: cloudSurfaceProbe(probe, subject),
    };
  }

  // --- apply's steps -------------------------------------------------------

  /** Fetch the bundle and read it into files. Throws; `apply` catches. */
  private async fetchBundle(
    http: CloudHttp,
    location: string,
  ): Promise<readonly BundleFile[]> {
    // A staged URL is a supplied upload's address and is fetched as it always
    // was. Anything else is a registry reference — the shape every built
    // artifact's ref has — and the bytes are the artifact's one layer.
    if (/^https?:\/\//.test(location)) {
      const fetched = await http.bytes(location);
      if (!fetched.ok) {
        // §6 blames the **platform** for an artifact that cannot be fetched,
        // and this is exactly that case: the build is green and the bytes are
        // not there. Raised as a typed error so `apply` maps it to the right
        // reason rather than to whichever one this branch happened to be near.
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
        token: this.options.token,
        ...(this.options.fetch === undefined
          ? {}
          : { fetch: this.options.fetch }),
      });
    } catch (cause) {
      if (!(cause instanceof OciPullError)) throw cause;
      // Same blame as the URL arm: the build is green and the bytes are not
      // fetchable in the form this Target serves.
      throw new ArtifactUnavailable(
        `the artifact at ${location} could not be fetched: ${cause.message}`,
      );
    }
    return readBundle(layer);
  }

  /**
   * The site, ensured rather than created.
   *
   * A site is a durable place and a deploy is a revision of what it serves —
   * the five steps below are the revision. So the only question here is
   * whether the place exists, and "it already does" is this function
   * succeeding, not failing.
   *
   * The read is `projects/{project}/sites/{id}`, which is the only form of it
   * the API serves. The flat `sites/{id}` this used to GET is not a route:
   * it 404s whether or not the site exists, so every deploy concluded the
   * site was missing, tried to create it, and collided with the one the
   * previous deploy made. A static App could be deployed exactly once.
   */
  private async ensureSite(
    http: CloudHttp,
    connection: StaticAdapterConnection,
    site: string,
  ): Promise<Outcome<HostingSite>> {
    const read = await http.json<HostingSite>({
      method: 'GET',
      path: this.sitePath(connection, site),
    });
    if (read.ok && read.value !== undefined) {
      return { ok: true, value: read.value };
    }
    if (!read.ok && !(read.kind === 'status' && read.status === 404)) {
      return { ok: false, failure: read };
    }

    const created = await http.json<HostingSite>({
      method: 'POST',
      path: `${API_VERSION}/projects/${encodeURIComponent(connection.project)}/sites`,
      query: { siteId: site },
      body: {},
    });
    // Losing a create race is the desired state arriving from somewhere else.
    // Read it back rather than trusting the 409's body, so what returns is a
    // site this function actually saw.
    if (!created.ok && created.kind === 'status' && created.status === 409) {
      const after = await http.json<HostingSite>({
        method: 'GET',
        path: this.sitePath(connection, site),
      });
      if (after.ok && after.value !== undefined) {
        return { ok: true, value: after.value };
      }
      return { ok: false, failure: created };
    }
    if (!created.ok) return { ok: false, failure: created };
    return { ok: true, value: created.value ?? {} };
  }

  /** The one form of a site's own resource name the API serves. */
  private sitePath(connection: StaticAdapterConnection, site: string): string {
    return `${API_VERSION}/projects/${encodeURIComponent(connection.project)}/sites/${encodeURIComponent(site)}`;
  }

  /**
   * Version → populate → upload → finalize → release.
   *
   * Five calls and no shortcut, because the product's contract is that a
   * version is immutable once finalized and a release is what makes one serve.
   * The upload step asks *which* files it does not already hold, which is what
   * makes a redeploy of an unchanged site cheap — and is also why the hash
   * offered is over the **gzipped** bytes rather than the file's own: that is
   * what the product stores and therefore what it deduplicates on.
   */
  private async release(
    http: CloudHttp,
    site: string,
    desired: DesiredState,
    files: readonly BundleFile[],
  ): Promise<Outcome<string>> {
    const compressed = new Map<string, { hash: string; bytes: Uint8Array }>();
    for (const file of files) {
      const bytes = Bun.gzipSync(file.bytes);
      compressed.set(file.path, { hash: sha256Hex(bytes), bytes });
    }

    const version = await http.json<HostingVersion>({
      method: 'POST',
      path: `${API_VERSION}/sites/${encodeURIComponent(site)}/versions`,
      body: {
        labels: {
          [DIGEST_LABEL]: desired.artifact.digest,
          [DEPLOY_LABEL]: desired.deploy,
        },
      },
    });
    if (!version.ok) return { ok: false, failure: version };
    const name = version.value?.name;
    if (name === undefined) {
      return { ok: false, failure: missing('the API created no version') };
    }

    // Every chunk answers with the hashes *it* named that are missing, and
    // with somewhere to put them, so both are accumulated across the whole
    // offer rather than read off the last call.
    const wanted = new Set<string>();
    let uploadUrl: string | undefined;
    for (const chunk of chunksOf([...compressed], POPULATE_LIMIT)) {
      const populated = await http.json<PopulateResult>({
        method: 'POST',
        path: `${API_VERSION}/${name}:populateFiles`,
        body: {
          files: Object.fromEntries(
            chunk.map(([path, file]) => [path, file.hash]),
          ),
        },
      });
      if (!populated.ok) return { ok: false, failure: populated };
      for (const hash of populated.value?.uploadRequiredHashes ?? []) {
        wanted.add(hash);
      }
      uploadUrl = populated.value?.uploadUrl ?? uploadUrl;
    }
    for (const file of compressed.values()) {
      if (!wanted.has(file.hash)) continue;
      if (uploadUrl === undefined) {
        return {
          ok: false,
          failure: missing(
            'the API asked for files and gave nowhere to put them',
          ),
        };
      }
      const uploaded = await http.upload({
        url: `${uploadUrl}/${file.hash}`,
        bytes: file.bytes,
        contentType: 'application/octet-stream',
      });
      if (!uploaded.ok) return { ok: false, failure: uploaded };
    }

    const finalized = await http.json<HostingVersion>({
      method: 'PATCH',
      path: `${API_VERSION}/${name}`,
      query: { updateMask: 'status' },
      body: { status: 'FINALIZED' },
    });
    if (!finalized.ok) return { ok: false, failure: finalized };

    const released = await http.json<HostingRelease>({
      method: 'POST',
      path: `${API_VERSION}/sites/${encodeURIComponent(site)}/releases`,
      query: { versionName: name },
      body: {},
    });
    if (!released.ok) return { ok: false, failure: released };
    return { ok: true, value: released.value?.name ?? name };
  }

  /** Put the vanity name on this site (§9). An existing one is not an error. */
  private async attachDomain(
    http: CloudHttp,
    site: string,
    domain: string,
  ): Promise<Outcome<void>> {
    const attached = await http.json<unknown>({
      method: 'POST',
      path: `${API_VERSION}/sites/${encodeURIComponent(site)}/domains`,
      body: { site, domainName: domain },
    });
    if (attached.ok) return { ok: true, value: undefined };
    // The name is already on this site, which is the state being asked for.
    if (attached.kind === 'status' && attached.status === 409) {
      return { ok: true, value: undefined };
    }
    return { ok: false, failure: attached };
  }

  // --- inspect's second half -----------------------------------------------

  private discover(connection: StaticAdapterConnection): TargetDiscovery {
    return {
      // Files are served, not run. An empty `arch` excludes no Target on
      // architecture, which is right: there is nothing here for an
      // architecture to be wrong about.
      arch: [],
      gpu: false,
      resourceCeiling: {},
      persistence: false,
      postgres: false,
      valkey: false,
      egressFiltering: false,
      // §16's verifiers check images at admission. Nothing is admitted here —
      // there is no image and no runtime — so there is nothing to enforce, and
      // reporting an engine would make `verifiedDeploy` true of a Target that
      // verifies nothing.
      policyEngine: { installed: false, mode: null },
      // §17: static hosting gets an **honest empty state** rather than a
      // duration. Zero is that: a tail can reach back no distance at all,
      // because no process ever wrote a line.
      logHistorySeconds: 0,
      servedHosts: connection.servedHosts ?? [],
      // Nothing is pulled: the files were uploaded, and the site holds them.
      reachableRegistries: [],
      // §10's reach rule, from the other side. A site has no runtime to resolve
      // a reference with, so it reaches no store — which is exactly why §10's
      // website exception exists, and why placement does not apply the reach
      // rule to the one kind this Target runs.
      reachableSecretStores: [] as readonly StoreAdapter[],
    };
  }

  // --- plumbing ------------------------------------------------------------

  private http(connection: StaticAdapterConnection): CloudHttp {
    return new CloudHttp({
      baseUrl: connection.endpoint,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private connectionOf(target: DeployTarget): StaticAdapterConnection | null {
    return target.connection.adapter === 'static' ? target.connection : null;
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

/** The artifact was addressed and the bytes were not there (§6's platform blame). */
class ArtifactUnavailable extends Error {
  override readonly name = 'ArtifactUnavailable';
}

/** A step that either produced something or carries the refusal that stopped it. */
type Outcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly failure: CloudFailure;
    };

/** A far side that answered successfully and left out what was asked for. */
function missing(message: string): CloudFailure {
  return { ok: false, kind: 'transport', message };
}

/** One site per (App, Component), within the length the product allows. */
export function siteId(desired: DesiredState): string {
  return workloadName(desired, SITE_ID_LIMIT);
}

/** The adapter's own handle on what `apply` placed — opaque to core (§6). */
function refOf(connection: StaticAdapterConnection, site: string): DeployRef {
  return `${connection.project}/sites/${site}`;
}

/** The site this ref names on this connection, or `null` if it names another. */
function parseRef(
  connection: StaticAdapterConnection,
  ref: DeployRef,
): string | null {
  const prefix = `${connection.project}/sites/`;
  if (!ref.startsWith(prefix)) return null;
  const site = ref.slice(prefix.length);
  return site.length === 0 || site.includes('/') ? null : site;
}

/**
 * One list as chunks of at most `size`, always at least one chunk.
 *
 * The empty case yields one empty chunk rather than none, because a version
 * with no files is still a version that has to be *told* it has no files —
 * skipping the call entirely would leave a site whose emptiness the API never
 * heard about, which is a different thing from an empty site.
 */
function chunksOf<Item>(items: readonly Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let at = 0; at < items.length; at += size) {
    chunks.push(items.slice(at, at + size));
  }
  return chunks.length === 0 ? [[]] : chunks;
}

/** The sha256 of some bytes, hex — what the product deduplicates files on. */
function sha256Hex(bytes: Uint8Array<ArrayBuffer>): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
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
    // developer under `BUILD_FAILED` — the one reason that crosses contracts,
    // and the reason §22 put in the shared vocabulary for exactly this.
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
