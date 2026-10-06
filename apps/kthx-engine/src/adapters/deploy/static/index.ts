/**
 * The static hosting deploy adapter. A release is atomic, so nothing is polled.
 * Public reach only: no authenticated edge can front the site's own address.
 */

import { type BundleFile, readBundle } from '@repo/archive/bundle';
import type { FederationOptions } from '@repo/archive/federation';
import type {
  StoreAdapter,
  TargetAdapter,
} from '../../../config/manifest.schema.ts';
import type {
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
  type StaticAdapterConnection,
  targetLabel,
} from '../../../domain/target.ts';
import { workloadName } from '../../../domain/workload-name.ts';
import {
  fetchableBundleUrl,
  parseGcsLocation,
} from '../../../storage/signed-url.ts';
import { cloudChecklist, cloudSurfaceProbe } from '../cloud/checklist.ts';
import { CloudHttp, type Fetcher, type TokenProvider } from '../cloud/http.ts';
import {
  cloudWriteFailure,
  missing,
  type Outcome,
  orderedChecklist,
} from '../cloud/verdict.ts';
import type {
  DeployAdapter,
  DeployEvent,
  DeployRef,
  DeployTarget,
  DeployVerdict,
  JobRuns,
  ObservedState,
  Restarted,
  RuntimeLogPage,
  RuntimeLogSubject,
  StartedRun,
} from '../contract.ts';
import { type DeployEvents, deployEvents, internalFailure } from '../events.ts';
import { parseScopedRef, scopedRef } from '../ref.ts';
import { ArtifactUnavailable, bundleFailure } from './bundle.ts';
import { googleRegistryRef, OciPullError, pullFilesLayer } from './oci.ts';

export interface StaticAdapterOptions {
  /** Mints a bearer token per request. Never a stored credential. */
  readonly token: TokenProvider;
  /**
   * Signs a short-lived URL for a supplied upload's `gs://` object, or `null`
   * where none is configured. Signing needs the federated identity itself.
   */
  readonly federation?: FederationOptions | null;
  readonly fetch?: Fetcher;
  readonly now?: () => number;
}

/** The product's name in the sentence about enabling it. */
const SERVICE_NAME = 'static hosting';

/** One API host serves every project; a Target's `endpoint` overrides it. */
export const DEFAULT_ENDPOINT = 'https://firebasehosting.googleapis.com';

const API_VERSION = '/v1beta1';

/** The label a version carries so `observe` can report what is serving. */
const DIGEST_LABEL = 'spindrift-digest';
const DEPLOY_LABEL = 'spindrift-deploy';

/** The product caps a site id well below a DNS label. */
const SITE_ID_LIMIT = 30;

const NOTHING_RUNS = 'Static files are served by the Target.';

/** The API's ceiling on file hashes per `populateFiles` call. */
const POPULATE_LIMIT = 1000;

interface HostingVersion {
  readonly name?: string;
  readonly status?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/** Which of the offered hashes `populateFiles` wants uploaded, and where. */
interface PopulateResult {
  readonly uploadRequiredHashes?: readonly string[];
  readonly uploadUrl?: string;
}

interface HostingRelease {
  readonly name?: string;
  readonly version?: HostingVersion;
}

interface HostingSite {
  readonly name?: string;
  readonly defaultUrl?: string;
}

export class StaticDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter = 'static';
  readonly artifactTypes: readonly ArtifactType[] = ['files'];

  private readonly events: DeployEvents;

  constructor(private readonly options: StaticAdapterOptions) {
    this.events = deployEvents(options.now);
  }

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return internalFailure('this Target is not a static hosting Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        `static hosting does not accept a ${desired.artifact.type} artifact`,
      );
    }
    if (desired.reach !== 'public') {
      // Placement already excludes this Target for a non-public Component, so
      // arriving here is core's bug.
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        `static hosting serves a public reach only, and this Component asks for ${desired.reach} (§9)`,
      );
    }
    if (desired.auth === 'proxy') {
      // There is no edge here to authenticate at.
      yield this.events.status('FAILED', { reason: 'INTERNAL' });
      return internalFailure(
        'static hosting has no authenticated edge to put in front of a Component (§9)',
      );
    }
    // This adapter pulls the bytes itself, so it takes a supplied upload's
    // address or a registry its federated token can read.
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

    const site = siteId(desired);
    const ref = refOf(connection, site);
    const http = this.http(connection);

    yield this.events.status('APPLYING', { resource: site });

    let files: readonly BundleFile[];
    try {
      files = await this.fetchBundle(http, location);
    } catch (cause) {
      const failure = bundleFailure(cause, ref);
      yield this.events.status('FAILED', {
        resource: site,
        reason: failure.reason,
      });
      return failure;
    }
    yield this.events.log(`the bundle holds ${files.length} files`, site);

    const created = await this.ensureSite(http, connection, site);
    if (created.ok === false) {
      const failure = cloudWriteFailure(created.failure, ref);
      yield this.events.status('FAILED', {
        resource: site,
        reason: failure.reason,
      });
      return failure;
    }

    const released = await this.release(http, site, desired, files);
    if (released.ok === false) {
      const failure = cloudWriteFailure(released.failure, ref);
      yield this.events.status('FAILED', {
        resource: site,
        reason: failure.reason,
      });
      return failure;
    }
    yield this.events.log(`released ${released.value}`, site);

    if (desired.hostname.vanity !== undefined) {
      const attached = await this.attachDomain(
        http,
        site,
        desired.hostname.vanity,
      );
      if (attached.ok === false) {
        const failure = cloudWriteFailure(attached.failure, ref);
        yield this.events.status('FAILED', {
          resource: site,
          reason: failure.reason,
        });
        return failure;
      }
      yield this.events.log(
        `the vanity name ${desired.hostname.vanity} is on this site`,
        site,
      );
    }

    const address = created.value.defaultUrl;
    yield this.events.status('LIVE', { resource: site });
    return {
      phase: 'LIVE',
      ref,
      // No reported address means no url, not one assembled here.
      ...(address === undefined ? {} : { url: address }),
      // No `address`: custom domains here take an A record and TXT
      // verification, which a CNAME cannot express.
    };
  }

  /**
   * What the latest release serves. The digest is a version label, so a version
   * released by anything else reports an empty digest and shows as drift.
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

  /**
   * Removes the site and spends its id: the product never releases a site id,
   * so that App and Component pair cannot have a site again.
   */
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

    // DELETE's 404 also means a path the API does not serve, so read the site
    // back. Only the project-scoped path answers; the flat one always 404s.
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
   * A static Target runs no jobs, so placement never sends one here. It still
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

  /** Fetch the bundle and read it into files. Throws; `apply` catches. */
  private async fetchBundle(
    http: CloudHttp,
    location: string,
  ): Promise<readonly BundleFile[]> {
    // Staged addresses fetch over HTTP (depot objects signed first), others are
    // registry refs. Errors name `location`, never the signed bearer URL.
    let url: string;
    try {
      url = await fetchableBundleUrl(
        location,
        this.options.federation,
        this.options.fetch,
      );
    } catch (cause) {
      // Failing to sign is the platform's fault, like any other missing bytes.
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
        token: this.options.token,
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
   * The site, created only if absent. Only the project-scoped path answers;
   * the flat `sites/{id}` 404s whether or not the site exists.
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
    // A 409 is a lost create race, which the read-back finds, or an id this
    // project once used and deleted, which is spent forever.
    if (!created.ok && created.kind === 'status' && created.status === 409) {
      const after = await http.json<HostingSite>({
        method: 'GET',
        path: this.sitePath(connection, site),
      });
      if (after.ok && after.value !== undefined) {
        return { ok: true, value: after.value };
      }
      // Only a 404 read-back proves the id is spent; any other failure keeps
      // the API's own report.
      if (!after.ok && after.kind === 'status' && after.status === 404) {
        return {
          ok: false,
          failure: {
            ...created,
            message: `the site id ${site} is taken and is not in this project — a site id is reserved permanently once used, including after its site is deleted, so this one is spent and cannot be reclaimed. Rename the App or the Component to deploy under a different name.`,
          },
        };
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
   * Version, populate, upload, finalize, release. Hashes are over the gzipped
   * bytes, which is what the product stores and deduplicates on.
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

    // Each chunk names only its own missing hashes, so they accumulate.
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

  /** Put the vanity name on this site. An existing one is not an error. */
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
    if (attached.kind === 'status' && attached.status === 409) {
      return { ok: true, value: undefined };
    }
    return { ok: false, failure: attached };
  }

  private discover(connection: StaticAdapterConnection): TargetDiscovery {
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
      // Nothing is pulled: the files were uploaded, and the site holds them.
      reachableRegistries: [],
      // A site has no runtime to resolve a secret reference with.
      reachableSecretStores: [] as readonly StoreAdapter[],
    };
  }

  private http(connection: StaticAdapterConnection): CloudHttp {
    return new CloudHttp({
      baseUrl: connection.endpoint ?? DEFAULT_ENDPOINT,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private connectionOf(target: DeployTarget): StaticAdapterConnection | null {
    return target.connection.adapter === 'static' ? target.connection : null;
  }
}

/** A staged bundle's address has a scheme; a registry reference never does. */
export const STAGED_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A supplied upload's fetchable address: `https://` as is, or `gs://` once
 * signed. `null` otherwise, such as for an `upload://` handle on a pod's disk.
 */
export function fetchableStagedAddress(staged: string | null): string | null {
  if (staged === null) return null;
  const fetchable =
    /^https?:\/\//.test(staged) || parseGcsLocation(staged) !== null;
  return fetchable ? staged : null;
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
    return `the artifact is staged at ${staged}, which names this installation's own disk rather than an address static hosting can fetch`;
  }
  const hosts = artifact.refs.map((ref) => ref.split('/')[0]).join(', ');
  return `static hosting fetches the bytes itself, and none of the artifact's homes (${hosts}) is a registry its identity can read`;
}

/** One site per (App, Component), within the length the product allows. */
export function siteId(desired: DesiredState): string {
  return workloadName(desired, SITE_ID_LIMIT);
}

function refOf(connection: StaticAdapterConnection, site: string): DeployRef {
  return scopedRef(connection.project, 'sites', site);
}

function parseRef(
  connection: StaticAdapterConnection,
  ref: DeployRef,
): string | null {
  return parseScopedRef(connection.project, 'sites', ref);
}

/**
 * Chunks of at most `size`. An empty list yields one empty chunk, because a
 * version with no files must still be told so.
 */
function chunksOf<Item>(items: readonly Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let at = 0; at < items.length; at += size) {
    chunks.push(items.slice(at, at + size));
  }
  return chunks.length === 0 ? [[]] : chunks;
}

/** Hex sha256, the hash the product deduplicates files on. */
function sha256Hex(bytes: Uint8Array<ArrayBuffer>): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}
