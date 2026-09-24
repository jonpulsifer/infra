/**
 * The Postgres schema; `db/migrations/` is hand-written to match it. No table
 * or type is named service, unit or deployment.
 */
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { BUILD_STATES, LOG_FIDELITIES } from '../adapters/build/contract.ts';
import {
  BLAMES,
  DEPLOY_PHASES,
  FAILURE_REASONS,
} from '../adapters/deploy/contract.ts';
import type { AuthoredManifest } from '../config/manifest.schema.ts';
import type {
  PrerequisiteResult,
  TargetDiscovery,
} from '../domain/capabilities.ts';
import type { Draft } from '../domain/creation-draft.ts';
import type { ArtifactType, DesiredDocument } from '../domain/desired-state.ts';
import type { TargetConnection } from '../domain/target.ts';
import {
  VESSEL_KINDS,
  type VesselDiscovery,
  type VesselLocation,
  type VesselPrerequisiteResult,
} from '../domain/vessel.ts';
import { FUNCTION_TARGETS } from '../functions/contract.ts';
import type { CoreSignature } from '../supply-chain/sign.ts';
import type { BackendProvenanceAssessment } from '../supply-chain/verify.ts';

/**
 * A jsonb column holding a document. Drizzle's jsonb stringifies, and Bun binds
 * a string as a JSON string, so the column would hold a scalar.
 */
const jsonbDocument = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return 'jsonb';
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    // A string is a double-encoded row written before jsonbDocument existed,
    // so no column may store a bare JSON string.
    return typeof value === 'string' ? JSON.parse(value) : value;
  },
});

export const appSourceKind = pgEnum('app_source_kind', ['repo', 'archive']);

/**
 * `frozen`: access lost; source-driven changes stop, no Deploy is torn down.
 */
export const repositoryAccess = pgEnum('repository_access', [
  'active',
  'frozen',
]);

export const componentKind = pgEnum('component_kind', [
  'service',
  'website',
  'job',
]);

/** Where a request may come from; {@link authMode} covers authentication. */
export const reachState = pgEnum('reach_state', ['none', 'private', 'public']);

/** `proxy`: the Target's authenticated edge stands in front. */
export const authMode = pgEnum('auth_mode', ['none', 'proxy']);

export const artifactType = pgEnum('artifact_type', [
  'image',
  'files',
  'vercel-output',
]);

export const buildStatus = pgEnum('build_status', ['PENDING', ...BUILD_STATES]);

export const logFidelity = pgEnum('log_fidelity', LOG_FIDELITIES);

/**
 * A build_requests row: PENDING until a bosun host claims it, CLAIMED while
 * leased, DONE once a result is written or the request is cancelled.
 */
export const BUILD_REQUEST_STATES = ['PENDING', 'CLAIMED', 'DONE'] as const;

export const buildRequestState = pgEnum(
  'build_request_state',
  BUILD_REQUEST_STATES,
);

export const deployPhase = pgEnum('deploy_phase', DEPLOY_PHASES);

export const deployReason = pgEnum('deploy_reason', FAILURE_REASONS);

/** Null for TIMEOUT, which indicts nobody. */
export const blame = pgEnum('blame', BLAMES);

export const datastoreEngine = pgEnum('datastore_engine', [
  'postgres',
  'valkey',
]);

/** `managed`: this platform authors the URL. `external`: the developer does. */
export const datastoreProvenance = pgEnum('datastore_provenance', [
  'managed',
  'external',
]);

/**
 * Mirrors targetAdapterSchema in `src/config/manifest.schema.ts`, which the
 * data layer does not import.
 */
export const targetAdapter = pgEnum('target_adapter', [
  'kubernetes',
  'cloudrun',
  'static',
  'vercel',
  'cloudflare-pages',
]);

/**
 * Decides only the shape of `vessels.location`. The runtimes a vessel carries
 * are the Targets that reference it.
 */
export const vesselKind = pgEnum('vessel_kind', VESSEL_KINDS);

export const targetStatus = pgEnum('target_status', [
  'connected',
  'disconnected',
]);

/** A declared connection starts unhealthy until the target loop inspects it. */
export const targetHealth = pgEnum('target_health', ['healthy', 'unhealthy']);

export const configItemKind = pgEnum('config_item_kind', [
  // A write-only pointer into the connected store, never a value.
  'secret_ref',
  // Holds the value: website build-time config, public once built.
  'plain',
  // Resolved by core at dispatch for the build only, never held by the runtime.
  // Kept out of the pinned config, so rotating one never mints a Deploy.
  'build_secret',
]);

export const attemptKind = pgEnum('attempt_kind', ['build', 'deploy']);

export const attemptEventType = pgEnum('attempt_event_type', ['log', 'status']);

/**
 * The ceremony a challenge was issued for. A response to another ceremony's
 * challenge is refused.
 */
export const webauthnPurpose = pgEnum('webauthn_purpose', [
  'enrol',
  'sign_in',
  'credential_admin',
  'add_passkey',
]);

/**
 * Singleton holding the authored manifest, never the resolved one: the
 * federation credential is read from the deployment on every load.
 */
export const installation = pgTable(
  'installation',
  {
    id: integer('id').primaryKey().default(1),
    manifest: jsonbDocument('manifest').$type<AuthoredManifest>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check('installation_singleton', sql`${table.id} = 1`)],
);

/**
 * One connected repository, shared by every App in it. No credential column:
 * tokens are minted per installation from the {@link githubApp} key.
 */
export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `owner/name`. */
    fullName: text('full_name').notNull(),
    /** GitHub's numeric installation id, kept as an opaque string. */
    installationId: text('installation_id').notNull(),
    defaultBranch: text('default_branch').notNull(),
    /**
     * The adopted default-branch commit; null until one has been reconciled.
     * Never a PR head or a branch tip.
     */
    authoritativeCommit: text('authoritative_commit'),
    /** Null until the config pull request is opened. */
    configPullRequest: integer('config_pull_request'),
    access: repositoryAccess('access').notNull().default('active'),
    frozenReason: text('frozen_reason'),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Connecting a repository twice re-adopts this row. Two rows would race
    // each other over one authoritative commit.
    unique('repositories_full_name_unique').on(table.fullName),
    check(
      'repositories_frozen_has_reason',
      sql`(${table.access} = 'frozen') = (${table.frozenReason} is not null)`,
    ),
  ],
);

/**
 * The private key is sealed, not hashed, since tokens are minted from it. Read
 * it per mint: setup fills this row while the pod runs.
 */
export const githubApp = pgTable(
  'github_app',
  {
    id: integer('id').primaryKey().default(1),
    appId: text('app_id').notNull(),
    slug: text('slug').notNull(),
    clientId: text('client_id').notNull(),
    encryptedPrivateKey: text('encrypted_private_key').notNull(),
    /** Null refuses webhook deliveries unless the environment supplies one. */
    encryptedWebhookSecret: text('encrypted_webhook_secret'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check('github_app_singleton', sql`${table.id} = 1`)],
);

/** Deleting an App deletes its Components but only detaches its Datastores. */
export const apps = pgTable(
  'apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    sourceKind: appSourceKind('source_kind').notNull(),
    /** Repo Apps only. */
    sourceRepoUrl: text('source_repo_url'),
    /** Repo Apps only: the named scope, never searched for. */
    sourceRepoSubpath: text('source_repo_subpath'),
    /**
     * Null for an archive App or an unconnected repository. `restrict`:
     * disconnecting a repository never deletes an App.
     */
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'restrict',
    }),
    /** Archive Apps only: the uploaded bundle's digest. */
    sourceArchiveDigest: text('source_archive_digest'),
    /**
     * Null lets rank order pick. A name narrows the candidates, never below a
     * Target's minimum; a retired one reads as unavailable.
     */
    buildRoute: text('build_route'),
    /**
     * A push deploys with no operator present. Off by default: it changes what
     * is live without anyone asking.
     */
    autoDeploy: boolean('auto_deploy').notNull().default(false),
    /**
     * A `dns.zones` entry for this App's names; null for the default. `zoneFor`
     * falls back to a zone serving the reach.
     */
    zone: text('zone'),
    /** A flat single-label name, if the developer chose one. */
    vanityDomain: text('vanity_domain'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Blocks new Deploys of this App, except `rollbackDeploy`, which sets it.
     */
    lockReason: text('lock_reason'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    /** The principal's id, as `deploys.requestedBy` records it. */
    lockedBy: text('locked_by'),
  },
  (table) => [
    check(
      'apps_lock_has_reason',
      sql`(${table.lockReason} is null) = (${table.lockedAt} is null)`,
    ),
  ],
);

export const components = pgTable(
  'components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: componentKind('kind').notNull(),
    /** Service only: an unexposed service is a queue worker. */
    expose: boolean('expose'),
    /** Job only: a cron expression. */
    schedule: text('schedule'),
    /** Null runs the image's own entrypoint and arguments. */
    command: jsonbDocument('command').$type<string[]>(),
    args: jsonbDocument('args').$type<string[]>(),
    reach: reachState('reach').notNull().default('private'),
    auth: authMode('auth').notNull().default('proxy'),
    /**
     * The Target this Component is placed on. The newest desired row cannot
     * answer that: any intent on a retired pair makes that row newest.
     */
    placedTargetId: uuid('placed_target_id').references(() => targets.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('components_app_id_name_unique').on(table.appId, table.name),
  ],
);

/**
 * One per (Component, commit, target shape). The id is a bigserial because
 * rollback compares Build ids as a total order.
 */
export const builds = pgTable(
  'builds',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => components.id, { onDelete: 'cascade' }),
    commit: text('commit').notNull(),
    targetShape: text('target_shape').notNull().$type<ArtifactType>(),
    artifactType: artifactType('artifact_type').notNull(),
    /** Null until the build produces an artifact. */
    artifactDigest: text('artifact_digest'),
    artifactRefs: jsonbDocument('artifact_refs').$type<string[]>(),
    status: buildStatus('status').notNull().default('PENDING'),
    /** The base image digest this build started from, for provenance. */
    baseDigest: text('base_digest'),
    runner: text('runner'),
    logFidelity: logFidelity('log_fidelity'),
    /**
     * Where the run can be watched; null for a route with none. A column
     * because LIVE_STATUS logs arrive only once the run ends.
     */
    runUrl: text('run_url'),
    /**
     * The last refusal sentence while PENDING, so a refusal repeated every tick
     * is logged once. Null when the Build is not waiting.
     */
    dispatchWaitingOn: text('dispatch_waiting_on'),
    /**
     * Deploy the artifact when this Build succeeds. Recorded at request time,
     * because the App's `autoDeploy` can change before the verdict.
     */
    deployOnSuccess: boolean('deploy_on_success').notNull().default(false),
    /** Identity of the dispatch attempt that holds or held this Build. */
    dispatchId: text('dispatch_id'),
    leasedAt: timestamp('leased_at', { withTimezone: true }),
    /**
     * Consecutive dispatch refusals, which drive backoff. A successful claim or
     * a fresh press resets it.
     */
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    /**
     * The earliest the build loop may retry; null means now. Each refusal
     * pushes it out exponentially, capped by `dispatchBackoffMs`.
     */
    nextDispatchAt: timestamp('next_dispatch_at', { withTimezone: true }),
    /** The backend envelope plus the facts core verified from it. */
    provenance:
      jsonbDocument('provenance').$type<BackendProvenanceAssessment>(),
    /** The verified SLSA build level that deploy admission checks. */
    verifiedBuildLevel: integer('verified_build_level'),
    /** Core's cosign record, written only after provenance passes. */
    signature: jsonbDocument('signature').$type<CoreSignature>(),
    /** The unsigned BuildKit materials document attached to the artifact. */
    buildkitProvenanceRef: text('buildkit_provenance_ref'),
    /** SPDX evidence attached to the artifact; not assessed. */
    sbomRef: text('sbom_ref'),
    /**
     * Names only, never values or store refs. Written at dispatch, before the
     * route runs, so a failed build records them too.
     */
    buildSecretNames: jsonbDocument('build_secret_names').$type<string[]>(),
    /** Passed to every build route; joins the source receipt to provenance. */
    bundleDigest: text('bundle_digest'),
    /**
     * Where the staged source bundle is fetched from. Not in `artifactRefs`,
     * which address the built artifact.
     */
    bundleLocation: text('bundle_location'),
    /**
     * The scope after a lone top-level directory is unwrapped. Per Build,
     * because two uploads to one App can wrap differently.
     */
    bundleSubpath: text('bundle_subpath'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * The commit's headline (see `commitHeadlineOf`), author login or name, and
     * authored time. Null for an archive.
     */
    commitMessage: text('commit_message'),
    commitAuthor: text('commit_author'),
    commitAuthoredAt: timestamp('commit_authored_at', { withTimezone: true }),
  },
  (table) => [
    unique('builds_component_commit_shape_unique').on(
      table.componentId,
      table.commit,
      table.targetShape,
    ),
  ],
);

/**
 * One placement of a Build on a Target. A rollback places an older Build again
 * without rebuilding it.
 */
export const deploys = pgTable('deploys', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  componentId: uuid('component_id')
    .notNull()
    .references(() => components.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id')
    .notNull()
    .references(() => targets.id, { onDelete: 'restrict' }),
  buildId: bigint('build_id', { mode: 'number' })
    .notNull()
    .references(() => builds.id, { onDelete: 'restrict' }),
  phase: deployPhase('phase').notNull().default('PENDING'),
  /** Set on a FAILED Deploy, and on a LIVE one the soak marked faulty. */
  reason: deployReason('reason'),
  /** Set with `reason`, except null for TIMEOUT. */
  blame: blame('blame'),
  detail: text('detail'),
  debug: jsonbDocument('debug'),
  /**
   * The adapter's opaque handle on what `apply` placed, handed back to
   * `observe` and `destroy`. Null until `apply` places something.
   */
  ref: text('ref'),
  url: text('url'),
  /** A hash over the pinned version references, stored for list reads. */
  configVersion: text('config_version'),
  /**
   * What this intent placed, captured when written; {@link DesiredDocument}
   * says which fields a later rollback replays. References only, never values.
   */
  desired: jsonbDocument('desired').$type<DesiredDocument>().notNull(),
  /**
   * Set when this Deploy's Target is disconnected; cleared when a reconnect
   * re-adopts it via `observe`. `deployState` reads it with the phase.
   */
  orphanedAt: timestamp('orphaned_at', { withTimezone: true }),
  /** Set while what runs differs from this release; cleared once it matches. */
  driftedAt: timestamp('drifted_at', { withTimezone: true }),
  /** The digest `observe` last reported as serving. */
  observedDigest: text('observed_digest'),
  /**
   * Why the platform will not converge on this release, in its words. Not
   * `detail`, which is for FAILED; this Deploy reached LIVE.
   */
  driftDetail: text('drift_detail'),
  /**
   * The attempt holding this Deploy's claim, minted by `claimNextDeploy`. Every
   * settling write must match it, because a lease can be reclaimed mid-apply.
   */
  attemptId: text('attempt_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Who asked: `AUTO_DEPLOY_PRINCIPAL.id` for a push, a user id for a press.
   * Null when unrecorded.
   */
  requestedBy: text('requested_by'),
  /**
   * A request: the attempt holding the claim ends the stream and writes FAILED.
   * `cancelDeploy` fails a PENDING intent itself.
   */
  cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  cancelRequestedBy: text('cancel_requested_by'),
  /**
   * When the soak, one `observe` at least `DEPLOY_SOAK_MS` after LIVE, found
   * nothing wrong. Null while the window is open; a release is judged once.
   */
  soakedAt: timestamp('soaked_at', { withTimezone: true }),
  /**
   * The soak saw the platform report this release failed after readiness. The
   * phase stays LIVE, with `reason`, `blame`, `detail` and `debug` filled.
   */
  faultyAt: timestamp('faulty_at', { withTimezone: true }),
});

/**
 * Which Build should be live on one (Component, Target). `SELECT ... FOR
 * UPDATE` on this row makes concurrent deploys an atomic check-and-set.
 */
export const componentTargetDesired = pgTable(
  'component_target_desired',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => components.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    /** Null until the first Deploy for this pair completes placement. */
    desiredBuildId: bigint('desired_build_id', { mode: 'number' }).references(
      () => builds.id,
      { onDelete: 'restrict' },
    ),
    /** The Deploy row whose intent last set `desiredBuildId`. */
    desiredDeployId: bigint('desired_deploy_id', {
      mode: 'number',
    }).references(() => deploys.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('component_target_desired_pair_unique').on(
      table.componentId,
      table.targetId,
    ),
  ],
);

/**
 * Top-level so it can be reattached to another App. Deleting an App sets
 * `appId` null and the row survives.
 */
export const datastores = pgTable(
  'datastores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    engine: datastoreEngine('engine').notNull(),
    provenance: datastoreProvenance('provenance').notNull(),
    appId: uuid('app_id').references(() => apps.id, { onDelete: 'set null' }),
    /**
     * The vessel, not a surface: two surfaces of one vessel provision into the
     * same place. `restrict`: removing a vessel never deletes its Datastores.
     */
    vesselId: uuid('vessel_id')
      .notNull()
      .references(() => vessels.id, { onDelete: 'restrict' }),
    /**
     * The adapter's opaque handle, which `observe` and `destroy` take. Null
     * until `provision` returns, and always for an external Datastore.
     */
    ref: text('ref'),
    /**
     * PENDING by default: the row is written before `provision`, so a name
     * collision hits the unique key before anything exists to collide with.
     */
    phase: deployPhase('phase').notNull().default('PENDING'),
    /** The operator's sentence, as the datastore loop last read it. */
    detail: text('detail'),
    /** A secret reference, never the credential. */
    connectionRef: text('connection_ref'),
    /**
     * The namespace last admitted, re-asserted when it differs from the App's.
     * Text, not a foreign key an App delete would null.
     */
    permittedNamespace: text('permitted_namespace'),
    /**
     * When the admit was last written. The loop rewrites it after an interval,
     * since a deleted policy leaves both columns agreeing.
     */
    permittedAt: timestamp('permitted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Adapters name objects after the Datastore, so two of one name in a vessel
    // are one object. A constraint, since an app-level check loses the race.
    unique('datastores_vessel_name_unique').on(table.vesselId, table.name),
  ],
);

/**
 * The tenancy boundary Targets are surfaces on: a cluster or a cloud project.
 * Facts true of the boundary live here, so two surfaces cannot disagree.
 */
export const vessels = pgTable(
  'vessels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: vesselKind('kind').notNull(),
    /**
     * Where the boundary is, in its kind's terms; never a credential. A Target
     * is addressable only once its connection and this are both set.
     */
    location: jsonbDocument('location').$type<VesselLocation>(),
    /** Reachability input shared by every surface on this vessel. */
    servedHosts: text('served_hosts').array(),
    reachableRegistries: text('reachable_registries').array(),
    /**
     * The boundary's own checklist. Null: never assessed; empty: assessed with
     * nothing asked. Health is derived from it on read.
     */
    prerequisites:
      jsonbDocument('prerequisites').$type<
        readonly VesselPrerequisiteResult[]
      >(),
    /**
     * Inventory found in the boundary (zones, Workers subdomain, Pages
     * projects). Null: never assessed; a null field: that read found nothing.
     */
    discovery: jsonbDocument('discovery').$type<VesselDiscovery>(),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Reconnecting a project reuses its vessel by name instead of splitting its
    // surfaces across two.
    unique('vessels_name_unique').on(table.name),
  ],
);

/**
 * Only discovered and asserted capabilities are stored. Derived ones are
 * recomputed on read, since a stored derivation goes stale unnoticed.
 */
export const targets = pgTable(
  'targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adapter: targetAdapter('adapter').notNull(),
    /** `restrict`: removing a vessel never deletes its Targets. */
    vesselId: uuid('vessel_id')
      .notNull()
      .references(() => vessels.id, { onDelete: 'restrict' }),
    status: targetStatus('status').notNull().default('connected'),
    rank: integer('rank').notNull(),
    /**
     * The surface half of how this Target is reached; never a credential. Null
     * until the manifest or an operator supplies connection facts.
     */
    connection: jsonbDocument('connection').$type<TargetConnection>(),
    health: targetHealth('health').notNull(),
    prerequisites:
      jsonbDocument('prerequisites').$type<readonly PrerequisiteResult[]>(),
    /** Discovered capabilities, as the adapter last reported them. */
    discovery: jsonbDocument('discovery').$type<TargetDiscovery>(),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
    /**
     * Operator assertions: nothing reports a tunnel or an authenticating proxy.
     * Null is unstated; `ASSERTED_REACHES_BY_ADAPTER` supplies the default.
     */
    reaches: reachState('reaches').array(),
    /**
     * Which reaches the authenticated edge can front, not whether it exists.
     */
    authReaches: reachState('auth_reaches').array(),
    /** Minimum SLSA build level for a Deploy here; null means the default. */
    minBuildLevel: integer('min_build_level'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A vessel carries one runtime per adapter, so reconnecting re-adopts this
    // pair instead of adding a Target that competes for its workloads.
    unique('targets_vessel_adapter_unique').on(table.vesselId, table.adapter),
  ],
);

/**
 * No role table: every enrolled user is fully privileged. `gatewayIdentity` is
 * the optional linked identity from the trusted Gateway.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    gatewayIdentity: text('gateway_identity'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One trusted identity cannot name two users.
    unique('users_gateway_identity_unique').on(table.gatewayIdentity),
  ],
);

/**
 * One in-progress creation flow. The document is replaced atomically under
 * `revision`, so a stale tab cannot overwrite a newer one.
 */
export const creationDrafts = pgTable('creation_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(0),
  draft: jsonbDocument('draft').$type<Draft>().notNull(),
  completedAppId: uuid('completed_app_id').references(() => apps.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Both stored halves come from the browser's own attestation parse, so no CBOR
 * decoder is needed; the enrolment token is the trust anchor.
 */
export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The credential id the authenticator minted, base64url. */
    credentialId: text('credential_id').notNull(),
    /** SPKI, base64url. Not a secret. */
    publicKey: text('public_key').notNull(),
    /** COSE algorithm id: -7 (ES256) or -257 (RS256). */
    algorithm: integer('algorithm').notNull(),
    /**
     * Stays 0 for a synced passkey; the clone check binds only if it counts.
     */
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    // A sign-in arrives with the credential id, so it names at most one row.
    unique('credentials_credential_id_unique').on(table.credentialId),
  ],
);

/**
 * Only the token's SHA-256 is stored, so a leaked database yields no
 * credential. A lookup hashes the presented token.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque token value, base64url. Never the value itself. */
    tokenHash: text('token_hash').notNull(),
    /**
     * A browser cookie or an agent bearer token. Every read filters on it, so a
     * value from one surface is refused at the other.
     */
    kind: text('kind')
      .$type<'browser' | 'agent'>()
      .notNull()
      .default('browser'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Agent path only; null means never presented. IP (first X-Forwarded-For
     * hop) and agent are self-reported: never authorize on them.
     */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    lastUsedAgent: text('last_used_agent'),
  },
  (table) => [unique('sessions_token_hash_unique').on(table.tokenHash)],
);

/**
 * Spent enrolment tokens by hash; the unique index blocks a second spend. A new
 * hash is a rotated token, and spending it replaces every passkey.
 */
export const enrolments = pgTable(
  'enrolments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the token that was spent, base64url. Never the token. */
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique('enrolments_token_hash_unique').on(table.tokenHash)],
);

/**
 * Single-use WebAuthn challenges. A signed cookie cannot prove a challenge is
 * unanswered; deleting the row on use can.
 */
export const webauthnChallenges = pgTable('webauthn_challenges', {
  /** The random value, base64url. */
  challenge: text('challenge').primaryKey(),
  purpose: webauthnPurpose('purpose').notNull(),
  /**
   * Credential changes bind their challenge to the authenticated User.
   * Bootstrap and sign-in have no principal yet, so their owner is null.
   */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/**
 * Config is scoped by environment, and a CHECK pins it to this one value, so
 * adding environments means relaxing the constraint, not adding a column.
 */
export const PINNED_ENVIRONMENT = 'default';

export const configItems = pgTable(
  'config_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => components.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    environment: text('environment').notNull().default(PINNED_ENVIRONMENT),
    key: text('key').notNull(),
    kind: configItemKind('kind').notNull().default('secret_ref'),
    /**
     * `secret_ref` only: the store's name for the item, as `put` minted it. A
     * pointer, never a value.
     */
    storeRef: text('store_ref'),
    /**
     * The pinned version. Its own column because `configVersion` hashes it and
     * any delimiter could appear in a store's item name.
     */
    storeVersion: text('store_version'),
    /** `plain` only: website build-time config, public once built. */
    plainValue: text('plain_value'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('config_items_scope_key_unique').on(
      table.componentId,
      table.targetId,
      table.environment,
      table.key,
    ),
    // A bound parameter is illegal in CHECK DDL, so this must be a SQL literal.
    check(
      'config_items_environment_pinned',
      sql`${table.environment} = ${sql.raw(`'${PINNED_ENVIRONMENT}'`)}`,
    ),
  ],
);

export const configAction = pgEnum('config_action', ['set', 'removed']);

/** Who changed which key, when. No value column: core never reads one back. */
export const configAuditEvents = pgTable('config_audit_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  componentId: uuid('component_id')
    .notNull()
    .references(() => components.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id')
    .notNull()
    .references(() => targets.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  action: configAction('action').notNull(),
  /** Who acted. Null once that user is gone; the fact of the change remains. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Kept so the trail still names a deleted user. */
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Log lines and status events of Build and Deploy attempts, in one stream.
 * Exactly one of `buildId` and `deployId` is set.
 */
export const attemptEvents = pgTable(
  'attempt_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    componentId: uuid('component_id')
      .notNull()
      .references(() => components.id, { onDelete: 'cascade' }),
    attemptKind: attemptKind('attempt_kind').notNull(),
    buildId: bigint('build_id', { mode: 'number' }).references(
      () => builds.id,
      { onDelete: 'cascade' },
    ),
    deployId: bigint('deploy_id', { mode: 'number' }).references(
      () => deploys.id,
      { onDelete: 'cascade' },
    ),
    eventType: attemptEventType('event_type').notNull(),
    /** Set when `eventType = 'log'`: one line of build or deploy output. */
    line: text('line'),
    /** Set when `eventType = 'status'`. Free text: Build and Deploy phases differ. */
    phase: text('phase'),
    resource: text('resource'),
    reason: deployReason('reason'),
    blame: blame('blame'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'attempt_events_exactly_one_attempt',
      sql`(${table.buildId} is not null) <> (${table.deployId} is not null)`,
    ),
    check(
      'attempt_events_kind_matches_reference',
      sql`(${table.attemptKind} = 'build' and ${table.buildId} is not null) or (${table.attemptKind} = 'deploy' and ${table.deployId} is not null)`,
    ),
    // One partial index per leg: every log read and the ceiling's seed COUNT
    // walk one leg in `id` order.
    index('attempt_events_build_id_id_idx')
      .on(table.buildId, table.id)
      .where(sql`${table.buildId} is not null`),
    index('attempt_events_deploy_id_id_idx')
      .on(table.deployId, table.id)
      .where(sql`${table.deployId} is not null`),
  ],
);

/**
 * One registry's push credential, keyed on host because a registry login and
 * the Docker config's `auths` are per host. Opened only at dispatch.
 */
export const registryCredentials = pgTable('registry_credentials', {
  /** The registry host, exactly as `registryHostOf` reads it off a namespace. */
  host: text('host').primaryKey(),
  /** Plain: not a secret, and an operator needs it to see the account. */
  username: text('username').notNull(),
  /** The sealed envelope. Never plaintext, and never returned by a command. */
  secret: text('secret').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The bosun build route's outbox. Bosun long-polls in to claim rows, since this
 * process cannot reach it. Accessed only through `src/storage/build-outbox.ts`.
 */
export const buildRequests = pgTable(
  'build_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The bosun class this request is routed to, e.g. a skiff pool name. */
    class: text('class').notNull(),
    /** The composed request document, handed back to the claimant verbatim. */
    request: jsonbDocument('request').notNull(),
    state: buildRequestState('state').notNull().default('PENDING'),
    /** Extended by each heartbeat; a CLAIMED row past it can be reclaimed. */
    leaseExpires: timestamp('lease_expires', { withTimezone: true }),
    /**
     * The lease holder; `heartbeat` and `complete` must match it. A call with
     * none is still served, as bosun and this image ship independently.
     */
    claimant: text('claimant'),
    /**
     * Null until `complete` writes it, and for a cancelled request. A late
     * result is still written while the row is not DONE.
     */
    result: jsonbDocument('result'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // What `claim` scans: the oldest PENDING row of a given class.
    index('build_requests_state_class_created_at_idx').on(
      table.state,
      table.class,
      table.createdAt,
    ),
  ],
);

/**
 * An author-written `fetch` handler. `target` is text with a CHECK over
 * `FUNCTION_TARGETS`, because a Postgres enum value cannot be dropped.
 */
export const functions = pgTable(
  'functions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    target: text('target').notNull(),
    source: text('source').notNull(),
    /**
     * Env map as one sealed envelope, null if empty; only a deploy opens it.
     */
    env: text('env'),
    url: text('url'),
    deployedAt: timestamp('deployed_at', { withTimezone: true }),
    /** Set when a saved function failed to deploy; the save still stands. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Bound parameters are illegal in CHECK DDL, hence `sql.raw` over literals.
    check(
      'functions_target',
      sql`${table.target} in (${sql.raw(
        FUNCTION_TARGETS.map((target) => `'${target}'`).join(','),
      )})`,
    ),
  ],
);

/**
 * Commit-to-bundle index over the source depot. A hint only: the bucket expires
 * ephemeral bundles, so `src/storage/bundle-cache.ts` checks every hit.
 */
export const sourceBundles = pgTable(
  'source_bundles',
  {
    /** `owner/name`, exactly as `stageRepository` was asked for it. */
    repository: text('repository').notNull(),
    /** A full sha, never a branch or a tag. */
    commit: text('commit').notNull(),
    digest: text('digest').notNull(),
    /** The `gs://` object this pair last staged to. */
    location: text('location').notNull(),
    /** Last fetch from the host. Informational: the depot decides a hit. */
    stagedAt: timestamp('staged_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Copied onto a sibling App's Build on a cache hit. */
    commitMessage: text('commit_message'),
    commitAuthor: text('commit_author'),
    commitAuthoredAt: timestamp('commit_authored_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: 'source_bundles_repository_commit_pk',
      columns: [table.repository, table.commit],
    }),
  ],
);

export const appsRelations = relations(apps, ({ one, many }) => ({
  components: many(components),
  datastores: many(datastores),
  repository: one(repositories, {
    fields: [apps.repositoryId],
    references: [repositories.id],
  }),
}));

export const repositoriesRelations = relations(repositories, ({ many }) => ({
  apps: many(apps),
}));

export const componentsRelations = relations(components, ({ one, many }) => ({
  app: one(apps, { fields: [components.appId], references: [apps.id] }),
  builds: many(builds),
  deploys: many(deploys),
  configItems: many(configItems),
  desiredTargets: many(componentTargetDesired),
  placedTarget: one(targets, {
    fields: [components.placedTargetId],
    references: [targets.id],
  }),
}));

export const buildsRelations = relations(builds, ({ one, many }) => ({
  component: one(components, {
    fields: [builds.componentId],
    references: [components.id],
  }),
  deploys: many(deploys),
}));

export const deploysRelations = relations(deploys, ({ one }) => ({
  component: one(components, {
    fields: [deploys.componentId],
    references: [components.id],
  }),
  target: one(targets, {
    fields: [deploys.targetId],
    references: [targets.id],
  }),
  build: one(builds, { fields: [deploys.buildId], references: [builds.id] }),
}));

export const componentTargetDesiredRelations = relations(
  componentTargetDesired,
  ({ one }) => ({
    component: one(components, {
      fields: [componentTargetDesired.componentId],
      references: [components.id],
    }),
    target: one(targets, {
      fields: [componentTargetDesired.targetId],
      references: [targets.id],
    }),
    desiredBuild: one(builds, {
      fields: [componentTargetDesired.desiredBuildId],
      references: [builds.id],
    }),
    desiredDeploy: one(deploys, {
      fields: [componentTargetDesired.desiredDeployId],
      references: [deploys.id],
    }),
  }),
);

export const datastoresRelations = relations(datastores, ({ one }) => ({
  app: one(apps, { fields: [datastores.appId], references: [apps.id] }),
  vessel: one(vessels, {
    fields: [datastores.vesselId],
    references: [vessels.id],
  }),
}));

export const targetsRelations = relations(targets, ({ one, many }) => ({
  vessel: one(vessels, {
    fields: [targets.vesselId],
    references: [vessels.id],
  }),
  deploys: many(deploys),
}));

export const vesselsRelations = relations(vessels, ({ many }) => ({
  targets: many(targets),
  datastores: many(datastores),
}));

export const configItemsRelations = relations(configItems, ({ one }) => ({
  component: one(components, {
    fields: [configItems.componentId],
    references: [components.id],
  }),
  target: one(targets, {
    fields: [configItems.targetId],
    references: [targets.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  credentials: many(credentials),
  sessions: many(sessions),
  creationDrafts: many(creationDrafts),
}));

export const creationDraftsRelations = relations(creationDrafts, ({ one }) => ({
  user: one(users, {
    fields: [creationDrafts.userId],
    references: [users.id],
  }),
  completedApp: one(apps, {
    fields: [creationDrafts.completedAppId],
    references: [apps.id],
  }),
}));

export const credentialsRelations = relations(credentials, ({ one }) => ({
  user: one(users, { fields: [credentials.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const attemptEventsRelations = relations(attemptEvents, ({ one }) => ({
  app: one(apps, { fields: [attemptEvents.appId], references: [apps.id] }),
  component: one(components, {
    fields: [attemptEvents.componentId],
    references: [components.id],
  }),
  build: one(builds, {
    fields: [attemptEvents.buildId],
    references: [builds.id],
  }),
  deploy: one(deploys, {
    fields: [attemptEvents.deployId],
    references: [deploys.id],
  }),
}));

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Component = typeof components.$inferSelect;
export type NewComponent = typeof components.$inferInsert;
export type Build = typeof builds.$inferSelect;
export type NewBuild = typeof builds.$inferInsert;
export type Deploy = typeof deploys.$inferSelect;
export type NewDeploy = typeof deploys.$inferInsert;
export type ComponentTargetDesired = typeof componentTargetDesired.$inferSelect;
export type NewComponentTargetDesired =
  typeof componentTargetDesired.$inferInsert;
export type Datastore = typeof datastores.$inferSelect;
export type NewDatastore = typeof datastores.$inferInsert;
export type Target = typeof targets.$inferSelect;
export type Vessel = typeof vessels.$inferSelect;
export type NewVessel = typeof vessels.$inferInsert;
export type NewTarget = typeof targets.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type CreationDraft = typeof creationDrafts.$inferSelect;
export type NewCreationDraft = typeof creationDrafts.$inferInsert;
export type Enrolment = typeof enrolments.$inferSelect;
export type NewEnrolment = typeof enrolments.$inferInsert;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;
export type NewWebauthnChallenge = typeof webauthnChallenges.$inferInsert;
export type ConfigItem = typeof configItems.$inferSelect;
export type NewConfigItem = typeof configItems.$inferInsert;
export type ConfigAuditEvent = typeof configAuditEvents.$inferSelect;
export type NewConfigAuditEvent = typeof configAuditEvents.$inferInsert;
export type AttemptEvent = typeof attemptEvents.$inferSelect;
export type NewAttemptEvent = typeof attemptEvents.$inferInsert;
export type BuildRequest = typeof buildRequests.$inferSelect;
export type NewBuildRequest = typeof buildRequests.$inferInsert;
export type FunctionRow = typeof functions.$inferSelect;
export type NewFunctionRow = typeof functions.$inferInsert;
export type SourceBundle = typeof sourceBundles.$inferSelect;
export type NewSourceBundle = typeof sourceBundles.$inferInsert;
