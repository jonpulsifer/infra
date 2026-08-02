/**
 * The Cloud Run deploy adapter (§6).
 *
 * Accepts an `image`, talks to the runtime's own API directly, and reads status
 * from the revision's conditions. There is no operator in between and nothing
 * to install: §6's "the GitOps operator *is* the pluggable machinery" has no
 * analogue here, which is why this adapter is smaller than the Kubernetes one
 * and why the Target's connection carries an endpoint rather than a flavour.
 *
 * **Never the build-from-source path** (§4). The runtime will happily take a
 * source archive and build it, and taking that offer would give this
 * installation a second build engine — with its own frontends, its own
 * defaults, and its own idea of what a website is — reachable only from one of
 * three backends. §4's "build is always separate from deploy" is what forbids
 * it, `service.ts` is where the document that carries no build is rendered, and
 * `test/adapters/cloudrun.test.ts` is what notices if one appears.
 *
 * **Nothing here watches.** `apply` polls the Service it just wrote for a
 * bounded window and `observe` is one read, exactly as the Kubernetes adapter
 * does — and here the poll is not even a compromise: this backend has no watch
 * to give up (plan, Transport shape).
 *
 * **No egress filtering is advertised** (§8). The runtime has network controls,
 * but not the by-name egress allowlist §8 specifies, and a capability reported
 * `true` on the strength of something adjacent is how a workload ends up placed
 * somewhere its egress was never actually constrained.
 */
import type {
  StoreAdapter,
  TargetAdapter,
} from '../../../config/manifest.schema.ts';
import type {
  PolicyEngineState,
  TargetDiscovery,
  TargetInspection,
} from '../../../domain/capabilities.ts';
import {
  type ArtifactType,
  artifactAddress,
  type DesiredState,
  type Exposure,
} from '../../../domain/desired-state.ts';
import type { CloudRunConnection } from '../../../domain/target.ts';
import { workloadName } from '../../../domain/workload-name.ts';
import { cloudChecklist } from '../cloud/checklist.ts';
import { CloudHttp, type Fetcher, type TokenProvider } from '../cloud/http.ts';
import { cloudWriteFailure, orderedChecklist } from '../cloud/verdict.ts';
import type {
  DeployAdapter,
  DeployEvent,
  DeployPhase,
  DeployRef,
  DeployTarget,
  DeployVerdict,
  FailureReason,
  ObservedState,
  RuntimeLogPage,
  RuntimeLogSubject,
  RuntimeLogTailOptions,
} from '../contract.ts';
import {
  allowsUnauthenticated,
  cloudRunService,
  invokerPolicy,
  serviceId,
} from './service.ts';
import {
  type CloudRunService,
  type CloudRunStatus,
  cloudRunStatus,
  servingDigest,
} from './status.ts';

export interface CloudRunAdapterOptions {
  /** Mints a bearer token per request. Never a stored credential (§13). */
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  /** The fast cadence, while an attempt is in flight (plan, Transport shape). */
  readonly pollIntervalMs?: number;
  /** How long an attempt may run before it is `TIMEOUT` (§6). */
  readonly timeoutMs?: number;
  /** Injected so a test does not spend the cadence it is asserting about. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Cloud Logging API root; injectable for perimeter endpoints and tests. */
  readonly logsEndpoint?: string;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_LOGS_ENDPOINT = 'https://logging.googleapis.com';
const SERVICE_ID_LIMIT = 63;

/** How the operator would name the service in the sentence about enabling it. */
const SERVICE_NAME = 'Cloud Run';

/**
 * What the runtime runs.
 *
 * A property of the backend rather than of a project — there is no call that
 * reports it — and it is stated here rather than left empty because an empty
 * `arch` means "no architecture excluded" to placement, which would let an
 * `arm64` build be placed somewhere it cannot run.
 */
const RUNTIME_ARCH = ['amd64'] as const;

/**
 * The largest single workload the runtime admits (§3's `resourceCeiling`).
 *
 * Documented limits of the service rather than a project's own quota, which is
 * lower for most projects and not readable from the API this adapter holds. So
 * it is a ceiling in the honest direction: a workload this rejects genuinely
 * does not fit anywhere, and one it admits may still be refused by a quota —
 * which §8 already routes to `REJECTED` and surfaces at Place as
 * `QUOTA_EXHAUSTED` when something has measured it.
 */
const RESOURCE_CEILING = { cpu: '8', memory: '32Gi' } as const;

/** The one store a Cloud Run revision can resolve a reference from natively. */
const NATIVE_STORE: readonly StoreAdapter[] = ['gcp-secret-manager'];

/** What a binary-authorization policy says, as much as this adapter reads. */
interface AdmissionPolicy {
  readonly globalPolicyEvaluationMode?: string;
  readonly defaultAdmissionRule?: {
    readonly evaluationMode?: string;
    readonly enforcementMode?: string;
  };
}

/** The enforcement mode that actually blocks rather than only recording. */
const BLOCKING = 'ENFORCED_BLOCK_AND_AUDIT_LOG';
/** The evaluation mode that verifies nothing, whatever its enforcement says. */
const VERIFIES_NOTHING = 'ALWAYS_ALLOW';

export class CloudRunDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter = 'cloudrun';
  /** §6's table: `cloudrun` takes an image. */
  readonly artifactTypes: readonly ArtifactType[] = ['image'];

  constructor(private readonly options: CloudRunAdapterOptions) {}

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return this.internal('this Target is not a Cloud Run Target');
    }
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal(
        `cloudrun does not accept a ${desired.artifact.type} artifact`,
      );
    }
    const image = artifactAddress(desired.artifact);
    if (image === null) {
      yield this.status('FAILED', { reason: 'INTERNAL' });
      return this.internal('the artifact carries no address to pull it by');
    }

    const id = serviceId(desired);
    const ref = refOf(connection, id);
    const http = this.http(connection);

    yield this.status('APPLYING', { resource: id });

    // §9: "tightening drops public reach first and stays red if the stricter
    // boundary does not come up." So for every non-public exposure the invoker
    // policy is written *before* the Service — a bounded outage is preferred
    // over a window in which the new revision is up and still reachable by
    // whoever the old one let in. On a Target that has nothing there yet this
    // call finds no Service and does nothing, which is why the policy is
    // written again after the rollout below: the closed state is **asserted**
    // on every deploy rather than inherited from the platform's default.
    if (!allowsUnauthenticated(desired.exposure)) {
      const tightened = await this.setInvoker(
        http,
        connection,
        id,
        desired.exposure,
      );
      if (tightened !== null) {
        yield this.status('FAILED', { resource: id, reason: tightened.reason });
        return { ...tightened, ref };
      }
    }

    const document = cloudRunService(desired, {
      project: connection.project,
      image,
      serviceAccount: connection.serviceAccount ?? null,
      // §16's "one signature, two verifiers": `policyEndpoint` is where this
      // project's admission policy is read from, so a Target that names one is
      // a Target whose project has a policy the Service must submit to.
      useProjectAdmissionPolicy: connection.policyEndpoint !== undefined,
    });
    const applied = await http.json<unknown>({
      method: 'PATCH',
      path: `/v2/${parentOf(connection)}/services/${encodeURIComponent(id)}`,
      // Create-or-update in one call, which is what makes `apply` idempotent
      // without core having to remember whether it placed this before.
      query: { allowMissing: 'true' },
      body: document,
    });
    if (!applied.ok) {
      const verdict = cloudWriteFailure(applied, ref);
      yield this.status('FAILED', { resource: id, reason: verdict.reason });
      return verdict;
    }
    yield this.log(`applied service ${id}`, id);

    const verdict = yield* this.awaitVerdict(http, connection, id, ref);
    if (verdict.phase !== 'LIVE') return verdict;

    // Now that the Service exists, the policy this exposure means is written
    // whichever direction it moved. Opening can only happen here — granting
    // invoke on something that is not there is not a call the API takes — and
    // tightening repeats a write it may already have made, which is idempotent
    // and is what makes "no non-public mode has a bypassable origin" this
    // adapter's guarantee rather than the platform default's.
    const written = await this.setInvoker(
      http,
      connection,
      id,
      desired.exposure,
    );
    if (written !== null) {
      yield this.status('FAILED', { resource: id, reason: written.reason });
      return { ...written, ref };
    }
    return verdict;
  }

  async observe(
    target: DeployTarget,
    ref: DeployRef,
  ): Promise<ObservedState | null> {
    const connection = this.connectionOf(target);
    if (connection === null) return null;
    const id = parseRef(connection, ref);
    if (id === null) return null;

    const read = await this.read(this.http(connection), connection, id);
    if (read === null) return null;

    const status = cloudRunStatus(read);
    return {
      ref,
      phase: status.phase,
      artifactDigest: servingDigest(read),
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(status.detail === undefined ? {} : { detail: status.detail }),
    };
  }

  async destroy(target: DeployTarget, ref: DeployRef): Promise<void> {
    const connection = this.connectionOf(target);
    if (connection === null) return;
    const id = parseRef(connection, ref);
    if (id === null) return;

    const deleted = await this.http(connection).json<unknown>({
      method: 'DELETE',
      path: `/v2/${parentOf(connection)}/services/${encodeURIComponent(id)}`,
    });
    // §6's idempotence: destroying what is already gone succeeds. Every other
    // refusal is raised, because a delete that silently did nothing is how an
    // orphaned Service outlives the App that paid for it.
    if (deleted.ok) return;
    if (deleted.kind === 'status' && deleted.status === 404) return;
    throw new Error(
      deleted.kind === 'status'
        ? `deleting service ${id} failed with ${deleted.status}: ${deleted.message}`
        : `deleting service ${id} failed: ${deleted.message}`,
    );
  }

  async tail(
    target: DeployTarget,
    subject: RuntimeLogSubject,
    options: RuntimeLogTailOptions = {},
  ): Promise<RuntimeLogPage> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      return { kind: 'stream', entries: [], cursor: null, reach: 0 };
    }
    const after = cloudLogCursor(options.after);
    const service = workloadName(subject, SERVICE_ID_LIMIT);
    const response = await new CloudHttp({
      baseUrl: this.options.logsEndpoint ?? DEFAULT_LOGS_ENDPOINT,
      token: this.options.token,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    }).json<CloudLogPage>({
      method: 'POST',
      path: '/v2/entries:list',
      body: {
        resourceNames: [`projects/${connection.project}`],
        filter: [
          'resource.type="cloud_run_revision"',
          `resource.labels.service_name="${service}"`,
          `resource.labels.location="${connection.region}"`,
          ...(after === null ? [] : [`timestamp>="${after.at}"`]),
        ].join(' AND '),
        orderBy: 'timestamp asc',
        pageSize: options.limit ?? 200,
      },
    });
    if (!response.ok) {
      throw new Error(`Cloud Logging read failed: ${response.message}`);
    }
    const records = (response.value.entries ?? [])
      .map(cloudLogRecord)
      .filter((record) => record !== null)
      .sort((left, right) =>
        left.at === right.at
          ? left.insertId.localeCompare(right.insertId)
          : left.at.localeCompare(right.at),
      )
      .filter(
        (record) =>
          after === null ||
          record.at > after.at ||
          (record.at === after.at && record.insertId > after.insertId),
      );
    const entries = records.map((record) => ({
      cursor: encodeCloudLogCursor(record),
      at: new Date(record.at),
      line: record.line,
      replica: record.replica,
    }));
    return {
      kind: 'stream',
      entries,
      cursor: entries.at(-1)?.cursor ?? options.after ?? null,
      reach: connection.logHistorySeconds ?? 0,
    };
  }

  /**
   * One pass of §13's checklist and §3's discovery, in one call.
   *
   * The checklist comes from a single probe — see `cloud/checklist.ts` — and
   * discovery is mostly properties of the runtime rather than of a project,
   * because there is no call that reports them. Which is fine, and is why they
   * are constants with the reasoning written down beside them: a value core
   * invented and a value core read are equally honest as long as nobody has to
   * guess which one they are looking at.
   */
  async inspect(target: DeployTarget): Promise<TargetInspection> {
    const connection = this.connectionOf(target);
    if (connection === null) {
      throw new Error(`${target.name} is not a Cloud Run Target`);
    }
    const http = this.http(connection);

    const probe = await http.json<unknown>({
      method: 'GET',
      path: `/v2/${parentOf(connection)}/services`,
      query: { pageSize: '1' },
    });

    const prerequisites = cloudChecklist(probe, {
      project: connection.project,
      service: SERVICE_NAME,
      scope: `${connection.project} in ${connection.region}`,
    });

    return {
      prerequisites: orderedChecklist(prerequisites, this.adapter),
      discovery: await this.discover(connection),
    };
  }

  // --- apply's second half -------------------------------------------------

  private async *awaitVerdict(
    http: CloudHttp,
    connection: CloudRunConnection,
    id: string,
    ref: DeployRef,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    const deadline =
      this.clock() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // `apply` already emitted APPLYING, so treat that as the first reported
    // phase: a Service whose terminal condition has not appeared yet must not
    // put a second identical event on the timeline.
    let reported: DeployPhase = 'APPLYING';

    for (;;) {
      const service = await this.read(http, connection, id);
      const status: CloudRunStatus =
        service === null ? { phase: 'APPLYING' } : cloudRunStatus(service);

      if (status.phase !== reported) {
        reported = status.phase;
        yield this.status(status.phase, {
          resource: id,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          ...(status.detail === undefined ? {} : { detail: status.detail }),
        });
      }

      if (status.phase === 'LIVE') {
        // §9: the platform names its own, so the canonical address comes back
        // across this seam rather than being handed in. A Service reported
        // ready with no `uri` is the one case core cannot fill in, and an
        // absent url is more honest than a name core assembled.
        const uri = service?.uri;
        return {
          phase: 'LIVE',
          ref,
          ...(uri === undefined ? {} : { url: uri }),
        };
      }

      if (status.phase === 'FAILED') {
        // §6's read on red is already done: unlike a cluster, the runtime puts
        // the reason on the object itself, so there are no pods to go and look
        // at. What §12 wants — the diagnosis surviving the platform's own
        // retention — is served by persisting `debug` on the Deploy row.
        return {
          phase: 'FAILED',
          ref,
          reason: status.reason ?? 'STARTUP_FAILED',
          ...(status.detail === undefined ? {} : { detail: status.detail }),
          debug: status.debug,
        };
      }

      if (this.clock() >= deadline) {
        yield this.status('FAILED', { resource: id, reason: 'TIMEOUT' });
        return {
          phase: 'FAILED',
          ref,
          reason: 'TIMEOUT',
          detail: status.detail ?? 'the revision did not settle in time',
          debug: status.debug,
        };
      }

      await this.wait();
    }
  }

  /** Write the invoker policy for one exposure, or say why it could not. */
  private async setInvoker(
    http: CloudHttp,
    connection: CloudRunConnection,
    id: string,
    exposure: Exposure,
  ): Promise<Omit<Extract<DeployVerdict, { phase: 'FAILED' }>, 'ref'> | null> {
    const written = await http.json<unknown>({
      method: 'POST',
      path: `/v2/${parentOf(connection)}/services/${encodeURIComponent(id)}:setIamPolicy`,
      body: invokerPolicy(exposure),
    });
    if (written.ok) return null;
    // A Service that does not exist yet cannot have a policy, and on the
    // tightening path that is the normal case rather than a failure: there is
    // no public reach to drop from something that was never placed.
    if (
      written.kind === 'status' &&
      written.status === 404 &&
      !allowsUnauthenticated(exposure)
    ) {
      return null;
    }
    const failure = cloudWriteFailure(written, id);
    return {
      phase: 'FAILED',
      reason: failure.reason,
      detail: `the invoker policy for ${exposure} could not be written: ${failure.detail}`,
      debug: failure.debug,
    };
  }

  // --- inspect's second half -----------------------------------------------

  private async discover(
    connection: CloudRunConnection,
  ): Promise<TargetDiscovery> {
    return {
      arch: [...RUNTIME_ARCH],
      // The runtime does offer accelerators, in some regions and behind their
      // own quota, and neither fact is readable from the call this adapter
      // makes. Reported `false` because a GPU capability that is wrong makes a
      // workload placeable where it cannot run, and one that is missing only
      // makes it placeable somewhere else.
      gpu: false,
      resourceCeiling: { ...RESOURCE_CEILING },
      // §11 keeps a Datastore a top-level noun with its own placement; nothing
      // this adapter drives hosts one, and a managed database beside it is
      // `external` provenance rather than something discovered here.
      persistence: false,
      postgres: false,
      redis: false,
      // §8: advertised as absent, deliberately. See the file's header.
      egressFiltering: false,
      policyEngine: await this.admissionPolicy(connection),
      logHistorySeconds: connection.logHistorySeconds ?? 0,
      servedHosts: connection.servedHosts ?? [],
      reachableRegistries: connection.reachableRegistries ?? [],
      // A revision resolves a pinned reference from its own project's store
      // over its own access path (§10's "one store of record, several access
      // paths"), so this is a property of the runtime rather than something
      // installed in the project.
      reachableSecretStores: [...NATIVE_STORE],
    };
  }

  /**
   * What this project's admission policy was found doing (§16, §32).
   *
   * §16's "one signature, two verifiers" makes this the cloud half, and §32's
   * rule applies unchanged: **enforcing, not installed.** Two ways a policy
   * proves nothing while looking configured, and both are reported `AUDIT` —
   * a dry-run enforcement that only writes a log entry, and an evaluation mode
   * that admits everything however it is enforced.
   *
   * A Target whose connection names no policy endpoint reports nothing
   * installed, which derives `verifiedDeploy: false`. That is the direction
   * this has to fail in: nobody said where to look, so nothing was verified.
   */
  private async admissionPolicy(
    connection: CloudRunConnection,
  ): Promise<PolicyEngineState> {
    if (connection.policyEndpoint === undefined) {
      return { installed: false, mode: null };
    }
    const read = await new CloudHttp({
      baseUrl: connection.policyEndpoint,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    }).json<AdmissionPolicy>({
      method: 'GET',
      path: `/v1/projects/${encodeURIComponent(connection.project)}/policy`,
    });
    if (!read.ok || read.value === undefined) {
      return { installed: false, mode: null };
    }

    const rule = read.value.defaultAdmissionRule;
    const blocking = rule?.enforcementMode === BLOCKING;
    const verifies =
      rule?.evaluationMode !== undefined &&
      rule.evaluationMode !== VERIFIES_NOTHING;
    return {
      installed: true,
      mode: blocking && verifies ? 'ENFORCE' : 'AUDIT',
    };
  }

  // --- plumbing ------------------------------------------------------------

  private http(connection: CloudRunConnection): CloudHttp {
    return new CloudHttp({
      baseUrl: connection.endpoint,
      token: this.options.token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private connectionOf(target: DeployTarget): CloudRunConnection | null {
    return target.connection.adapter === 'cloudrun' ? target.connection : null;
  }

  /** One Service, or `null` where there is nothing there. */
  private async read(
    http: CloudHttp,
    connection: CloudRunConnection,
    id: string,
  ): Promise<CloudRunService | null> {
    const read = await http.json<CloudRunService>({
      method: 'GET',
      path: `/v2/${parentOf(connection)}/services/${encodeURIComponent(id)}`,
    });
    return read.ok ? (read.value ?? null) : null;
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

interface CloudLogPage {
  readonly entries?: readonly CloudLogEntry[];
}

interface CloudLogEntry {
  readonly timestamp?: string;
  readonly receiveTimestamp?: string;
  readonly insertId?: string;
  readonly textPayload?: string;
  readonly jsonPayload?: unknown;
  readonly resource?: { readonly labels?: Record<string, string> };
}

interface CloudLogRecord {
  readonly at: string;
  readonly insertId: string;
  readonly line: string;
  readonly replica: string;
}

function cloudLogRecord(entry: CloudLogEntry): CloudLogRecord | null {
  const at = entry.timestamp ?? entry.receiveTimestamp;
  if (!at || !entry.insertId) return null;
  const line =
    entry.textPayload ??
    (entry.jsonPayload === undefined
      ? null
      : JSON.stringify(entry.jsonPayload));
  if (line === null || line.trim() === '') return null;
  return {
    at,
    insertId: entry.insertId,
    line,
    replica: entry.resource?.labels?.revision_name ?? 'unknown',
  };
}

function cloudLogCursor(cursor: string | undefined): CloudLogRecord | null {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64').toString('utf8'),
    ) as {
      at?: unknown;
      insertId?: unknown;
    };
    return typeof value.at === 'string' && typeof value.insertId === 'string'
      ? { at: value.at, insertId: value.insertId, line: '', replica: '' }
      : null;
  } catch {
    return null;
  }
}

function encodeCloudLogCursor(record: CloudLogRecord): string {
  return Buffer.from(
    JSON.stringify({ at: record.at, insertId: record.insertId }),
  ).toString('base64');
}

/** `projects/<p>/locations/<r>` — the parent every call hangs off. */
function parentOf(connection: CloudRunConnection): string {
  return `projects/${connection.project}/locations/${connection.region}`;
}

/**
 * The adapter's own handle on what `apply` placed — opaque to core (§6).
 *
 * It carries the project and the region as well as the id because an operator
 * may reconnect a Target against a different project, and a ref that named only
 * the Service would then be read against the wrong one — reporting a healthy
 * workload that is not the one this Deploy placed.
 */
function refOf(connection: CloudRunConnection, id: string): DeployRef {
  return `${parentOf(connection)}/services/${id}`;
}

/** The id this ref names on this connection, or `null` if it names another. */
function parseRef(
  connection: CloudRunConnection,
  ref: DeployRef,
): string | null {
  const prefix = `${parentOf(connection)}/services/`;
  if (!ref.startsWith(prefix)) return null;
  const id = ref.slice(prefix.length);
  return id.length === 0 || id.includes('/') ? null : id;
}
