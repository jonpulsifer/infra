/**
 * Spindrift's own store (§12 State: "One Postgres... Kubernetes-objects-as-
 * database, git, and split stores are rejected; the transactional
 * requirement rules out JSON files and anything eventually consistent").
 *
 * This file is the whole schema; `drizzle-kit generate` reads it to produce
 * `db/migrations/0000_init.sql`, which is what actually ships.
 *
 * Object model (§2): five nouns, two authored by a human (`App`, `Datastore`).
 * `Target` and `User` are admin-surface nouns a developer never creates.
 * `Build` and `Component` round out the five. The names `service`, `unit`,
 * and `deployment` are forbidden as table or type names here — they are
 * lost to collisions elsewhere in this repo's world (§2) — so the noun for
 * "one artifact on one Target" is `deploys`, not `deployments`, and a
 * Component's `kind` may hold the *value* `'service'` (the spec's own
 * vocabulary) without the table or enum being named after it.
 *
 * Concurrency and rollback (§6, §12) rest on a transactional row, not a
 * token: `componentTargetDesired` is that row, one per (Component, Target),
 * locked with `SELECT ... FOR UPDATE` to make two concurrent deploys an
 * atomic check-and-set. `Build.id` is a `bigserial` on purpose — its total
 * order is the mechanism rollback compares against ("a newer intent row
 * pointing at an older Build"), which an unordered id could not give it.
 */
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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
import type {
  PrerequisiteResult,
  TargetDiscovery,
} from '../domain/capabilities.ts';
import type { TargetConnection } from '../domain/target.ts';

// --- Enums -----------------------------------------------------------------
//
// Where an enum's values are also a contract vocabulary, the enum is built
// from the contract's own tuple rather than restating it. §6 asks for **one
// shared vocabulary**, and two spellings of one closed set is what a
// translation table between them is made of.

/** §2: "source = repo(url, subpath) | archive(upload)". */
export const appSourceKind = pgEnum('app_source_kind', ['repo', 'archive']);

/** §2: "kind = service | website | job". */
export const componentKind = pgEnum('component_kind', [
  'service',
  'website',
  'job',
]);

/**
 * §9: "Exposure is three states with `Private` as the default." Shared by a
 * Component's authored setting and a Deploy's rendered `DesiredState.exposure`
 * (§6) — one vocabulary, not two.
 */
export const exposureState = pgEnum('exposure_state', [
  'internal',
  'private',
  'public',
]);

/** §6 `DesiredState.artifact.type`: "image | files". */
export const artifactType = pgEnum('artifact_type', ['image', 'files']);

/**
 * §4: "Concurrency: no ordinal... a build records an artifact rather than
 * deploying one." Build has no `SUPERSEDED` verdict; this is the plain
 * lifecycle of a single build attempt.
 */
export const buildStatus = pgEnum('build_status', ['PENDING', ...BUILD_STATES]);

/** §4: "a declared `logFidelity` of `LIVE_TEXT | LIVE_STATUS | ON_COMPLETION`." */
export const logFidelity = pgEnum('log_fidelity', LOG_FIDELITIES);

/** §6: "PENDING -> APPLYING -> WAITING -> LIVE | FAILED". */
export const deployPhase = pgEnum('deploy_phase', DEPLOY_PHASES);

/**
 * §6: the closed reason set a `FAILED` Deploy carries. "One shared
 * vocabulary": Build and Deploy attempts both write reasons from this set
 * into `attemptEvents`, so a reason never needs a second table to mean the
 * same thing twice.
 */
export const deployReason = pgEnum('deploy_reason', FAILURE_REASONS);

/**
 * §6: "`blame` is the most useful thing the UI knows." `TIMEOUT` carries no
 * blame, hence nullable everywhere this is used.
 */
export const blame = pgEnum('blame', BLAMES);

/** §11: "for two wire protocols: `postgres` and `redis`." */
export const datastoreEngine = pgEnum('datastore_engine', [
  'postgres',
  'redis',
]);

/** §11: "Two provenances, differing only in who authors the URL." */
export const datastoreProvenance = pgEnum('datastore_provenance', [
  'managed',
  'external',
]);

/**
 * §6/§13: "`Target`... has exactly one adapter type." Values mirror
 * `targetAdapterSchema` in `src/config/manifest.schema.ts`; kept as an
 * independent enum here so the data layer does not import the config layer
 * for a handful of string literals.
 */
export const targetAdapter = pgEnum('target_adapter', [
  'kubernetes',
  'cloudrun',
  'static',
]);

/**
 * §13: "Disconnect always works: live Deploys go `orphaned`... reconnect
 * re-adopts via `observe`." The Target row itself just remembers which of
 * those two states it is in.
 */
export const targetStatus = pgEnum('target_status', [
  'connected',
  'disconnected',
]);

/**
 * §13: "Connect always succeeds; health is a standing prerequisite checklist."
 * Two states rather than three — the connect act runs one pass of the checklist
 * before it returns, so no Target ever exists unassessed.
 */
export const targetHealth = pgEnum('target_health', ['healthy', 'unhealthy']);

/**
 * §10: "One mechanism, no secret/non-secret classification... Narrow
 * exception: a website's build-time config... lives as ordinary rows." A
 * `secret_ref` row is write-only (a pointer into the connected store); a
 * `plain` row is the narrow exception, holding a real value because it was
 * always going to be public once baked into the site.
 */
export const configItemKind = pgEnum('config_item_kind', [
  'secret_ref',
  'plain',
]);

/**
 * §6: "One attempt-scoped event log... Build and Deploy both write to it."
 * `attemptKind` says which of the two subjects an event belongs to.
 */
export const attemptKind = pgEnum('attempt_kind', ['build', 'deploy']);

/**
 * §6: "carrying log lines and status events `{phase, resource?, reason?,
 * blame?}`." A row is one or the other.
 */
export const attemptEventType = pgEnum('attempt_event_type', ['log', 'status']);

// --- App and Component -------------------------------------------------

/**
 * §2: "App <- authored... immutable vessel reference, domain, config." One
 * App owns many Components. Deleting an App detaches its Datastores and
 * never cascades to them (§2, §11) but does cascade to its own Components,
 * Builds, Deploys, and config items — none of those are reattachable.
 */
export const apps = pgTable('apps', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sourceKind: appSourceKind('source_kind').notNull(),
  /** Set when `sourceKind = 'repo'`. */
  sourceRepoUrl: text('source_repo_url'),
  /** Set when `sourceKind = 'repo'`; the scope is named, never searched (§5). */
  sourceRepoSubpath: text('source_repo_subpath'),
  /** Set when `sourceKind = 'archive'`: the uploaded bundle's digest. */
  sourceArchiveDigest: text('source_archive_digest'),
  /** §14: the cloud project this App's own resources live in, if any. */
  vesselRef: text('vessel_ref'),
  /** §9: the flat single-label vanity name, if the developer chose one. */
  vanityDomain: text('vanity_domain'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * §2: "`schedule` is a field on a job, not a kind. `expose` is a field on a
 * service." Both stay nullable columns on the one Component table rather
 * than becoming separate nouns.
 */
export const components = pgTable(
  'components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: componentKind('kind').notNull(),
    /** Service only: an unexposed service is a queue worker (§2). */
    expose: boolean('expose'),
    /** Job only: a cron expression. */
    schedule: text('schedule'),
    /** §9: network-serving Components carry an exposure state; default Private. */
    exposure: exposureState('exposure').notNull().default('private'),
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

// --- Build and Deploy ----------------------------------------------------

/**
 * §2: "one per (Component, commit, target-shape)". §6: "Build's id IS the
 * total order" — a `bigserial`, not a `uuid`, is what makes an id
 * comparable at all, which rollback depends on ("a newer intent row
 * pointing at an older Build").
 */
export const builds = pgTable(
  'builds',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => components.id, { onDelete: 'cascade' }),
    commit: text('commit').notNull(),
    /**
     * §3: "Resolution runs before the build and outputs placement plus
     * artifact shape, which is why Build's key includes target-shape."
     */
    targetShape: text('target_shape').notNull(),
    artifactType: artifactType('artifact_type').notNull(),
    /** Set once the build produces a digestible artifact. */
    artifactDigest: text('artifact_digest'),
    artifactRefs: jsonb('artifact_refs').$type<string[]>(),
    status: buildStatus('status').notNull().default('PENDING'),
    /** §4: the base image digest this build started from, for provenance. */
    baseDigest: text('base_digest'),
    /** §4: "The build backend and its fidelity are visible on the Build." */
    runner: text('runner'),
    logFidelity: logFidelity('log_fidelity'),
    /** §16: the normalized provenance envelope Core derived, if assessed. */
    provenance: jsonb('provenance'),
    /**
     * §4/§32: "The bundle digest must be a build parameter on every route,"
     * the join between a source receipt and its provenance document.
     */
    bundleDigest: text('bundle_digest'),
    /**
     * Where the staged bundle is fetched from (§15: "fetches the exact commit
     * once and stages an immutable source bundle for either builder").
     *
     * Beside the digest rather than folded into `artifactRefs`: those are
     * addresses the *artifact* can be pulled by, and a bundle that has not been
     * built yet has no artifact. Conflating them makes a source upload's
     * location vanish the moment it is not a supplied artifact.
     */
    bundleLocation: text('bundle_location'),
    /**
     * §5's named scope for this bundle, after a lone top-level directory has
     * been unwrapped.
     *
     * Per Build rather than per App because the unwrap is a fact about the bytes
     * that were uploaded, and two uploads to one App may wrap differently. A
     * repo App keeps its scope on the App, where the developer named it.
     */
    bundleSubpath: text('bundle_subpath'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
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
 * §2: "one Build → many Deploys — this is what makes two runtimes cost no
 * new concept and what makes rollback-without-rebuild possible." §10:
 * `configVersion` lives here as a field, "scoped to (Component, Target)",
 * which is what makes a Deploy "exactly Heroku's Release."
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
  /** Set only when `phase = 'failed'`. */
  reason: deployReason('reason'),
  /** Set only when `phase = 'failed'`; null exactly when `reason = 'timeout'`. */
  blame: blame('blame'),
  /** §6: "`FAILED` carries a closed reason set plus free-text `detail`." */
  detail: text('detail'),
  /** §6: "and a raw `debug` payload." */
  debug: jsonb('debug'),
  /**
   * §6: the adapter's own handle on what `apply` placed — "opaque to core,
   * which stores it and hands it back to `observe` and `destroy`." This column
   * is that storage. Null until an `apply` places something.
   */
  ref: text('ref'),
  url: text('url'),
  /** §10: "a hash over a document of pinned version references." */
  configVersion: text('config_version'),
  exposure: exposureState('exposure'),
  /**
   * §13: "Disconnect always works: live Deploys go `orphaned`, workloads keep
   * running." Set when the Target this Deploy sits on was disconnected, and
   * cleared when a reconnect re-adopts it via `observe`.
   *
   * A timestamp beside the phase rather than a sixth phase value: the phases
   * are the platform's verdict on a rollout (§6), and an orphaned workload is
   * still whatever the platform last said it was — what changed is that
   * Spindrift can no longer see it. `deployState` in `src/domain/target.ts`
   * reads the two together.
   */
  orphanedAt: timestamp('orphaned_at', { withTimezone: true }),
  /**
   * §6: "**Drift is detected and surfaced, never silently corrected** — a
   * visible state with a one-click re-converge."
   *
   * *Visible* is what makes this a column. A loop that noticed drift and only
   * returned it would surface it to nobody: the UI reads rows, and a fact that
   * lives for the length of one pass is a fact the screen can never show.
   * Cleared when what is running matches again, so a drift that somebody fixed
   * out of band stops being reported without anyone having to dismiss it.
   */
  driftedAt: timestamp('drifted_at', { withTimezone: true }),
  /**
   * The digest `observe` last reported as actually serving.
   *
   * Stored beside the drift flag rather than derived from it because "what is
   * running instead" is the first question anyone asks, and by the time they
   * ask, the answer is one poll interval old at best.
   */
  observedDigest: text('observed_digest'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * §6/§12: "Concurrency and rollback rest on a transactional row, not a
 * token": `Component@Target.desired`, "one row: which artifact should be
 * live here." A locking read (`SELECT ... FOR UPDATE`) on this row is the
 * atomic check-and-set that makes two concurrent deploys resolve safely,
 * and "rollback is an ordinary deploy" — a newer `desiredDeployId` pointing
 * at an older `desiredBuildId`.
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
    // The task's hard requirement: a UNIQUE key on (component_id, target_id),
    // kept as its own named constraint rather than folded into a composite
    // primary key so a catalog query for a UNIQUE constraint finds exactly
    // that.
    unique('component_target_desired_pair_unique').on(
      table.componentId,
      table.targetId,
    ),
  ],
);

// --- Datastore -------------------------------------------------------------

/**
 * §11: "Top-level and attached, not a field, forced by reattachment to a
 * different App." `appId` is nullable because "deleting an App detaches its
 * Datastores and never cascades" (§2) — detachment is `appId = null`, the
 * row survives.
 */
export const datastores = pgTable('datastores', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  engine: datastoreEngine('engine').notNull(),
  provenance: datastoreProvenance('provenance').notNull(),
  appId: uuid('app_id').references(() => apps.id, { onDelete: 'set null' }),
  /** §11: "Delivery follows the Datastore's placement." */
  targetId: uuid('target_id')
    .notNull()
    .references(() => targets.id, { onDelete: 'restrict' }),
  /**
   * §11: "an in-cluster secret reference in-cluster... a pinned store
   * reference everywhere else." Never a copy of the credential itself.
   */
  connectionRef: text('connection_ref'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Target and User ---------------------------------------------------

/**
 * §13: "`Target` keeps its name, stays flat, and has exactly one adapter
 * type."
 *
 * §3's four capability provenances are not four columns. Only the two that
 * are facts about *this* Target are stored — what was `discovered`, and the
 * one `asserted` value — because from-the-adapter-type is a property of the
 * code and `derived` is a conclusion core redraws from the other two every
 * time it reads them. Storing a derived value is storing something that can
 * be stale in a way nothing will notice.
 */
export const targets = pgTable(
  'targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    adapter: targetAdapter('adapter').notNull(),
    status: targetStatus('status').notNull().default('connected'),
    /** §13: "set a global ordered rank across Targets." */
    rank: integer('rank').notNull(),
    /**
     * How the adapter reaches this Target — `TargetConnection` in
     * `src/domain/target.ts`. Never a credential: §13 settles one auth mode,
     * "native OIDC federation, nothing stored."
     */
    connection: jsonb('connection').$type<TargetConnection>().notNull(),
    /** §13: the standing checklist's last verdict. */
    health: targetHealth('health').notNull(),
    /** One `PrerequisiteResult` per item, with the sentence behind each. */
    prerequisites:
      jsonb('prerequisites').$type<readonly PrerequisiteResult[]>(),
    /** §3's discovered half, as the adapter last reported it. */
    discovery: jsonb('discovery').$type<TargetDiscovery>(),
    /** When the one loop (§13) last ran against this Target. */
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
    /**
     * §3: "`publicExposure` is the single genuine assertion: no cluster API
     * reports whether a tunnel exists." Null until an operator states it.
     */
    publicExposure: boolean('public_exposure'),
    /** §4/§13: "a Target to declare a minimum SLSA Build Level." */
    minBuildLevel: integer('min_build_level'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Connect is idempotent by name: reconnecting re-adopts rather than
    // registering a second Target that would compete for the same workloads.
    unique('targets_name_unique').on(table.name),
  ],
);

/**
 * §"First run and identity": an operator enrolls a passkey and gets a fully
 * privileged account; there is no role table in v1 because every enrolled
 * user is that one privileged kind. `gatewayIdentity` is the optional
 * linked identity from the front-door Gateway, kept distinct from
 * Spindrift's own user model on purpose.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  gatewayIdentity: text('gateway_identity'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Config -----------------------------------------------------------------

/**
 * §10: "One store per Target, per-key, pinned... One secret per variable,
 * not a blob." §2: "config is stored scoped by an environment key pinned to
 * one value, so environments and previews can arrive later without a
 * migration." The column exists now; the check constraint pins it to the
 * one value v1 ever writes, so a later migration only has to relax the
 * constraint, not add the column.
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
     * §10: "Values are write-only." Set only when `kind = 'secret_ref'`: a
     * pointer (path/version) into the connected store, never a value.
     */
    storeRef: text('store_ref'),
    /**
     * §10: the narrow website exception — set only when `kind = 'plain'`,
     * because a website's build-time config "becomes public either way."
     */
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
    // A bound parameter is not legal inside a CHECK constraint's DDL, hence
    // `sql.raw` rather than the usual interpolation — this must be a SQL
    // literal, not a query argument.
    check(
      'config_items_environment_pinned',
      sql`${table.environment} = ${sql.raw(`'${PINNED_ENVIRONMENT}'`)}`,
    ),
  ],
);

// --- Attempt log -------------------------------------------------------

/**
 * §6: "One attempt-scoped event log keyed by (App, Component, attempt),
 * carrying log lines and status events `{phase, resource?, reason?,
 * blame?}`. Build and Deploy both write to it; the UI subscribes once."
 *
 * This task owns the table only. Task 11 owns the domain code that writes
 * to it and may extend it with a follow-up migration; the columns below are
 * the shared shape the spec names, not the final word on it.
 *
 * Exactly one of `buildId` / `deployId` is set per row — which attempt this
 * event belongs to — enforced by the check constraint below rather than by
 * two separate tables, because the log itself is one stream (§6: "the UI
 * subscribes once").
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
    /** §6: "`resource?` is what buys the per-resource feel at three fidelities." */
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
  ],
);

// --- Relations (query-builder convenience; no schema effect) ---------------

export const appsRelations = relations(apps, ({ many }) => ({
  components: many(components),
  datastores: many(datastores),
}));

export const componentsRelations = relations(components, ({ one, many }) => ({
  app: one(apps, { fields: [components.appId], references: [apps.id] }),
  builds: many(builds),
  deploys: many(deploys),
  configItems: many(configItems),
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
  target: one(targets, {
    fields: [datastores.targetId],
    references: [targets.id],
  }),
}));

export const targetsRelations = relations(targets, ({ many }) => ({
  deploys: many(deploys),
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

// --- Row types ---------------------------------------------------------

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
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
export type NewTarget = typeof targets.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ConfigItem = typeof configItems.$inferSelect;
export type NewConfigItem = typeof configItems.$inferInsert;
export type AttemptEvent = typeof attemptEvents.$inferSelect;
export type NewAttemptEvent = typeof attemptEvents.$inferInsert;
