/**
 * The Vercel deploy adapter. Nothing is built on Vercel: a `vercel-output` tree
 * deploys through its CLI as prebuilt, and a `files` upload through the API. A
 * deployment queues before it serves, so this polls it to a verdict.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { BundleError, type BundleFile, readBundle } from '@repo/archive/bundle';
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

export interface VercelAdapterOptions {
  /**
   * The platform bearer, read per request from the installation Secret. Vercel
   * federates outward only, so there is no projected token to exchange.
   */
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
  readonly sleep?: (ms: number) => Promise<void>;
  /** How often the deployment is polled while it queues and builds. */
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  /**
   * Deploys a `vercel-output` artifact. Defaults to {@link runVercelCli}; a test
   * injects a fake.
   */
  readonly deployPrebuilt?: PrebuiltDeploy;
}

export interface PrebuiltDeployInput {
  /** The extracted deployment tree, the CLI's working directory. */
  readonly directory: string;
  readonly project: string;
  readonly team: string;
  /** Passed as `VERCEL_TOKEN`, never in argv where the process list shows it. */
  readonly token: string;
  /** Stamped onto the deployment so `findDeployment` can adopt it. */
  readonly meta: Readonly<Record<string, string>>;
}

export type PrebuiltDeployResult = { ok: true } | { ok: false; detail: string };

export type PrebuiltDeploy = (
  input: PrebuiltDeployInput,
) => Promise<PrebuiltDeployResult>;

/**
 * `vercel deploy --prebuilt`, which uploads the Build Output tree and each
 * function's `filePathMap` files from its working directory. `--no-wait` returns
 * at once, so the caller finds and polls the deployment.
 */
async function runVercelCli(
  input: PrebuiltDeployInput,
): Promise<PrebuiltDeployResult> {
  const meta = Object.entries(input.meta).flatMap(([key, value]) => [
    '--meta',
    `${key}=${value}`,
  ]);
  // The image ships no `bunx` shim, and `bunx` would fetch `vercel` over the
  // network, since the extracted tree has no node_modules.
  let cli: string;
  try {
    cli = Bun.resolveSync('vercel/dist/vc.js', import.meta.dir);
  } catch (cause) {
    return {
      ok: false,
      detail: `the vercel CLI is not installed in this image: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  // HOME is writable scratch apart from the tree: the root filesystem is
  // read-only, and the CLI declines to deploy `$HOME` yet still exits 0.
  const home = await mkdtemp(join(tmpdir(), 'spindrift-vercel-home-'));
  try {
    const proc = Bun.spawn(
      [
        'bun',
        cli,
        'deploy',
        '--prebuilt',
        '--prod',
        '--yes',
        '--no-wait',
        '--cwd',
        input.directory,
        '--scope',
        input.team,
        '--project',
        input.project,
        ...meta,
      ],
      {
        env: {
          ...process.env,
          VERCEL_TOKEN: input.token,
          VERCEL_TELEMETRY_DISABLED: '1',
          HOME: home,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code === 0) return { ok: true };
    return {
      ok: false,
      detail: stderr.trim().slice(-2000) || `vercel deploy exited ${code}`,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * The artifact holds regular files only, so the build records each `.func`
 * symlink here as `{ path, target }` from the deployment root, and
 * {@link extractTree} restores them.
 */
const LINKS_MANIFEST = '.vercel/output/__spindrift/func-links.json';

/**
 * Writes the artifact's files relative to `dir` and restores the build's
 * symlinks. The bundle is untrusted, so every link must resolve inside the tree.
 */
async function extractTree(
  files: readonly BundleFile[],
  dir: string,
): Promise<void> {
  for (const file of files) {
    const path = join(dir, file.path.replace(/^\/+/, ''));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
  }

  const manifest = join(dir, LINKS_MANIFEST);
  let links: readonly { path: string; target: string }[];
  try {
    links = JSON.parse(await readFile(manifest, 'utf8'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  await rm(dirname(manifest), { recursive: true });
  // Checked with `realpath` once the link exists, since a target can walk
  // through an earlier link. Earlier links passed too, so `mkdir` cannot escape.
  const root = await realpath(dir);
  const inside = (path: string) => path === root || path.startsWith(root + sep);
  for (const link of links) {
    const at = resolve(root, link.path);
    const escapes = () =>
      new BundleError(
        'PATH_ESCAPES_BUNDLE',
        `the build output links ${link.path} to ${link.target}, which does not resolve inside the deployment`,
      );
    if (!inside(at)) throw escapes();
    await mkdir(dirname(at), { recursive: true });
    await symlink(link.target, at);
    const real = await realpath(at).catch(() => null);
    if (real === null || !inside(real)) throw escapes();
  }
}

/** The platform's name in a sentence about it. */
const SERVICE_NAME = 'Vercel';

/** One API host serves every team; a Target's `endpoint` overrides it. */
export const DEFAULT_ENDPOINT = 'https://api.vercel.com';

/**
 * The `meta` keys every deployment is stamped with. One made elsewhere has
 * none, so it reports an empty digest and shows as drift.
 */
const DIGEST_META = 'spindriftDigest';
const DEPLOY_META = 'spindriftDeploy';

const NOTHING_RUNS = 'Static files are served by the Target.';

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

interface Deployment {
  readonly id?: string;
  readonly url?: string;
  readonly readyState?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string | null;
  readonly meta?: Readonly<Record<string, string>>;
}

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
   * `vercel-output` carries functions. `files` is still taken for a supplied
   * upload, which has no build to produce more.
   */
  readonly artifactTypes: readonly ArtifactType[] = ['vercel-output', 'files'];

  private readonly events: DeployEvents;
  private readonly deployPrebuilt: PrebuiltDeploy;

  constructor(private readonly options: VercelAdapterOptions) {
    this.events = deployEvents(options.now);
    this.deployPrebuilt = options.deployPrebuilt ?? runVercelCli;
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

    // The platform bearer authorizes nothing at a registry, so the registry arm
    // reads with the federated token.
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

    // Every create is a new production deployment, so a re-run adopts the one
    // this Deploy already made unless it failed. Read-then-create is not atomic.
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

    // A Build Output tree deploys through the CLI; a `files` upload, below.
    if (desired.artifact.type === 'vercel-output') {
      const directory = await mkdtemp(join(tmpdir(), 'spindrift-vercel-'));
      let result: PrebuiltDeployResult;
      try {
        await extractTree(files, directory);
        result = await this.deployPrebuilt({
          directory,
          project,
          team: connection.team,
          token: await this.options.token(),
          meta: {
            [DEPLOY_META]: desired.deploy,
            [DIGEST_META]: desired.artifact.digest,
          },
        });
      } catch (cause) {
        // A link escaping the tree is the build's fault, like an unreadable bundle.
        const failure = bundleFailure(cause, ref);
        yield this.events.status('FAILED', {
          resource: project,
          reason: failure.reason,
        });
        return failure;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      if (!result.ok) {
        yield this.events.status('FAILED', {
          resource: project,
          reason: 'INTERNAL',
        });
        return internalFailure(result.detail);
      }
      // `--no-wait` returns no id, so the deployment is found by its meta.
      const made = await this.findDeployment(
        http,
        connection,
        project,
        desired.deploy,
      );
      if (made?.uid === undefined) {
        const failure = cloudWriteFailure(
          missing(
            'vercel deploy created a deployment the API did not then list',
          ),
          ref,
        );
        yield this.events.status('FAILED', {
          resource: project,
          reason: failure.reason,
        });
        return failure;
      }
      yield this.events.log(
        `created deployment ${made.uid} via vercel deploy`,
        project,
      );
      return yield* this.release(
        http,
        connection,
        project,
        made.uid,
        ref,
        desired,
      );
    }

    const uploaded = await this.upload(http, connection, files);
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
   * What production serves now. A dashboard promote or rollback moves it
   * without telling core, so the deployment `apply` made is not the answer.
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

  async run(_target: DeployTarget, _ref: DeployRef): Promise<StartedRun> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  async restart(_target: DeployTarget, _ref: DeployRef): Promise<Restarted> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  async executions(_target: DeployTarget, _ref: DeployRef): Promise<JobRuns> {
    return { kind: 'none', because: NOTHING_RUNS };
  }

  /** The checklist, discovery and surface, from one read of the team. */
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

  /**
   * Fetch the bundle and read it into files. Throws; `apply` catches. Errors
   * name `location`, never the signed URL, which is a bearer capability.
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
   * The production deployment stamped with this Deploy's {@link DEPLOY_META}.
   * The `meta-` filter is what the CLI's `list --meta` sends; the REST reference
   * omits it. `null` also when the read is refused, so a flaky list never blocks.
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
   * One request per file, since the API has no populate step. The platform keys
   * uploads by the SHA-1 of the raw bytes, and a deployment names files by it.
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
        url: `${this.endpointOf(connection)}/v2/files?teamId=${encodeURIComponent(connection.team)}`,
        bytes: file.bytes,
        contentType: 'application/octet-stream',
        headers: {
          'x-vercel-digest': sha,
          'Content-Length': String(file.bytes.byteLength),
        },
      });
      if (!uploaded.ok) return { ok: false, failure: uploaded };
      // Deployment paths are relative, so the bundle's leading slash comes off.
      referenced.push({
        file: file.path.replace(/^\/+/, ''),
        sha,
        size: file.bytes.byteLength,
      });
    }
    return { ok: true, value: referenced };
  }

  /** The production deployment for a supplied `files` upload, served as is. */
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
        // Otherwise a framework mismatch waits on a confirmation nobody gives.
        skipAutoDetectionConfirmation: '1',
      },
      body: {
        name: project,
        // Creates the project on the first deployment and addresses it after.
        project,
        target: 'production',
        files,
        meta: {
          [DIGEST_META]: desired.artifact.digest,
          [DEPLOY_META]: desired.deploy,
        },
        // Nothing to detect, install or build. These persist on the project.
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

  /** Put the vanity name on this project. An existing one is not an error. */
  private async attachDomain(
    http: CloudHttp,
    connection: VercelAdapterConnection,
    project: string,
    domain: string,
  ): Promise<Outcome<void>> {
    // Read first: the platform answers 400 both for a domain already here and
    // for one it will not accept.
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
   * Polls the deployment to a verdict. The platform's queue and build states
   * all report as one `WAITING`.
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
      // The write landed, so a refused poll is retried until the deadline, and
      // `TIMEOUT` is the verdict if it never clears.
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
        // The `url` is a host without a scheme.
        const host = read.ok ? read.value?.url : undefined;
        return {
          phase: 'LIVE',
          ref,
          ...(host === undefined ? {} : { url: `https://${host}` }),
          // Every project answers on the same vendor CNAME, whichever
          // deployment is live.
          address: {
            recordType: 'CNAME',
            target: 'cname.vercel-dns.com',
            proxied: true,
          },
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

  private discover(connection: VercelAdapterConnection): TargetDiscovery {
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
      // No runtime logs are read from this platform.
      logHistorySeconds: 0,
      servedHosts: connection.servedHosts ?? [],
      // Nothing is pulled — the bytes were uploaded, and the edge holds them.
      reachableRegistries: [],
      // Functions read the project's environment, since the platform resolves no
      // references. Every Vercel Target lists it; discovery cannot see artifacts.
      reachableSecretStores: ['vercel'] as readonly StoreAdapter[],
    };
  }

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
    return `the artifact is staged at ${staged}, which names this installation's own disk rather than an address Vercel can be fed from`;
  }
  const hosts = artifact.refs.map((ref) => ref.split('/')[0]).join(', ');
  return `Vercel is fed the bytes, and none of the artifact's homes (${hosts}) is a registry this installation's identity can read`;
}

/**
 * `CANCELED` and `BLOCKED` are `REJECTED`, not a build failure: someone stopped
 * the deployment, or the account's policy refused it.
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
 * The prerequisite checklist from one probe. `API_TOKEN` stands in for
 * `OIDC_FEDERATION`, since the platform federates nothing inward.
 */
export function vercelChecklist(
  probe: CloudResponse<unknown>,
  team: string,
): readonly PrerequisiteResult[] {
  return tokenChecklist(probe, subjectOf(team));
}

/**
 * Whether the probe shows the team carries deployments. Never `absent`: every
 * team can hold projects, and a refusal is not an absence.
 */
export function vercelSurfaceProbe(
  probe: CloudResponse<unknown>,
  team: string,
): SurfaceProbe {
  return tokenSurfaceProbe(probe, subjectOf(team));
}

function subjectOf(team: string): TokenChecklistSubject {
  return { service: SERVICE_NAME, vessel: team, noun: 'team' };
}

/**
 * One project per (App, Component), by {@link vercelProjectName}, which the store
 * adapter shares so config is written to the project deploys use.
 */
export function projectName(desired: DesiredState): string {
  return vercelProjectName(desired);
}

function refOf(
  connection: VercelAdapterConnection,
  project: string,
): DeployRef {
  return scopedRef(connection.team, 'projects', project);
}

function parseRef(
  connection: VercelAdapterConnection,
  ref: DeployRef,
): string | null {
  return parseScopedRef(connection.team, 'projects', ref);
}

/** Hex SHA-1, what the platform keys uploaded files by. */
function sha1Hex(bytes: Uint8Array<ArrayBuffer>): string {
  return new Bun.CryptoHasher('sha1').update(bytes).digest('hex');
}
