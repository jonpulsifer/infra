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
  customType,
  index,
  integer,
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
import type { AuthoredManifest } from '../config/manifest.schema.ts';
import type {
  PrerequisiteResult,
  TargetDiscovery,
} from '../domain/capabilities.ts';
import type { Draft } from '../domain/creation-draft.ts';
import type { DesiredDocument } from '../domain/desired-state.ts';
import type { TargetConnection } from '../domain/target.ts';
import {
  VESSEL_KINDS,
  type VesselLocation,
  type VesselPrerequisiteResult,
} from '../domain/vessel.ts';
import type { CoreSignature } from '../supply-chain/sign.ts';
import type { BackendProvenanceAssessment } from '../supply-chain/verify.ts';

/**
 * A `jsonb` column that stores a JSON **document**, not a JSON string.
 *
 * Drizzle's own `jsonb` encoder hands the driver `JSON.stringify(value)`, and
 * Bun's SQL client serialises a JS string bound to a `jsonb` parameter *as a
 * JSON string*. The document is therefore encoded twice, and the column holds a
 * scalar: `jsonb_typeof(...)` is `'string'` and `draft->>'appName'` is `NULL`.
 *
 * Nothing caught it because the read path is symmetric — Bun parses the `jsonb`
 * back to a JS string and the decoder parses that — so the application always
 * got its object back. What it costs is every SQL-side use of the document: a
 * predicate, a GIN index, a generated column, or a data migration reading inside
 * one of these columns matches nothing rather than erroring.
 *
 * Passing the value through untouched is the fix; Bun binds objects and arrays
 * to `jsonb` correctly on its own. `null` never reaches {@link toDriver} —
 * Drizzle emits SQL `NULL` for it — so a nullable column still stores SQL `NULL`
 * rather than a JSON `null`, and `IS NULL` keeps meaning what it meant.
 *
 * {@link fromDriver} still parses a string so that rows written before
 * `0016_jsonb_documents` read correctly during a rollout, when the new image and
 * the un-migrated rows overlap. It is the same decode Drizzle already did. The
 * one thing it forbids is a column whose document is legitimately a JSON string;
 * none is, and a scalar in a `jsonb` column here would be a modelling mistake.
 */
const jsonbDocument = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return 'jsonb';
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
  },
});

// --- Enums -----------------------------------------------------------------
//
// Where an enum's values are also a contract vocabulary, the enum is built
// from the contract's own tuple rather than restating it. §6 asks for **one
// shared vocabulary**, and two spellings of one closed set is what a
// translation table between them is made of.

/** §2: "source = repo(url, subpath) | archive(upload)". */
export const appSourceKind = pgEnum('app_source_kind', ['repo', 'archive']);

/**
 * §15: "Lost access **freezes source-driven changes and never destroys a
 * Deploy**."
 *
 * Two states, and the pair is the whole point. `frozen` has to be a value a
 * query can select on, because the alternative to a state is an action — and
 * the only actions available to code that has just lost read access to a
 * repository are to do nothing quietly or to tear something down. The first is
 * indistinguishable from a repository nobody pushes to, and the second is the
 * outage §15 forbids.
 */
export const repositoryAccess = pgEnum('repository_access', [
  'active',
  'frozen',
]);

/** §2: "kind = service | website | job". */
export const componentKind = pgEnum('component_kind', [
  'service',
  'website',
  'job',
]);

/**
 * §9's exposure, as the two independent facts it always was: where a request can
 * come from, and whether something authenticates it.
 *
 * The three states it replaces picked three of the six cells, and both omitted
 * routed ones are things people ask for — RFC1918-without-auth is the dashboard
 * you do not want to log into on your own network, and tunnel-with-auth is
 * sharing something with people who are not on your tailnet.
 *
 * Both are shared by a Component's authored setting and a Deploy's rendered
 * `DesiredState` (§6) — one vocabulary, not two.
 */
export const reachState = pgEnum('reach_state', ['none', 'private', 'public']);

/** Whether the Target's native authenticated edge stands in front (§9). */
export const authMode = pgEnum('auth_mode', ['none', 'proxy']);

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

/**
 * The bosun build outbox's own lifecycle — not {@link buildStatus}, and not
 * built from a shared contract tuple the way that one is from
 * {@link BUILD_STATES}. A `build_requests` row is core's *outbox entry*, one
 * layer below a Build: `PENDING` until a bosun host claims it, `CLAIMED` for
 * the life of its lease, `DONE` once a result has landed (win or lose). The
 * one place this vocabulary is read outside this file is
 * `src/storage/build-outbox.ts`, and it reads it off `BuildRequest['state']`
 * rather than restating the tuple — kept here, beside the table, because
 * nothing outside the outbox needs to name these three states.
 */
export const BUILD_REQUEST_STATES = ['PENDING', 'CLAIMED', 'DONE'] as const;

export const buildRequestState = pgEnum(
  'build_request_state',
  BUILD_REQUEST_STATES,
);

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

/**
 * §11: "for two wire protocols". Named for what this platform runs behind each
 * — CloudNativePG or Cloud SQL, the Valkey operator or Memorystore for Valkey —
 * rather than for the protocol's older namesake, so an engine value never names
 * a product no Target here can provision.
 */
export const datastoreEngine = pgEnum('datastore_engine', [
  'postgres',
  'valkey',
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
  'vercel',
  'cloudflare-pages',
]);

/**
 * The tenancy boundary a Target is a surface on — `VesselKind` in
 * `src/domain/vessel.ts`.
 *
 * A different axis from {@link targetAdapter}, which names the runtime, and a
 * narrower one than it looks: this decides the shape of `vessels.location` and
 * nothing else. Which runtimes are on a boundary is the set of Targets that
 * reference it, established by probing at connect — so nothing reads this
 * column to learn what a vessel carries, and nothing reads an adapter back to
 * this column either. Kept as an independent enum here for the reason the
 * adapter one is.
 */
export const vesselKind = pgEnum('vessel_kind', VESSEL_KINDS);

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
 * Two states rather than three — a declared connection starts unhealthy with
 * an awaiting-inspection reason, and the target loop replaces that provisional
 * checklist with observations.
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

/**
 * Which WebAuthn ceremony a challenge was issued for. The two are not
 * interchangeable — a `create` response answering a `get` challenge is the
 * ceremony confusion `src/auth/webauthn.ts` refuses — so the purpose travels
 * with the challenge rather than being inferred from which endpoint replies.
 */
export const webauthnPurpose = pgEnum('webauthn_purpose', [
  'enrol',
  'sign_in',
  'credential_admin',
  'add_passkey',
]);

// --- Installation ----------------------------------------------------------

/**
 * The one installation this control plane represents.
 *
 * The manifest is ordinary configuration, not a credential, and §12 makes
 * Postgres its durable store. A deployment declaration reconciles into this
 * row at process start; without one, every process can recover the same last
 * validated value from the database.
 *
 * The **authored** document, never the resolved one. What the deployment
 * already declares — its federation credential — is read from the deployment on
 * every load and is not representable here, so this row cannot hold a copy that
 * disagrees with the pod it is running in.
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

// --- Repository ------------------------------------------------------------

/**
 * One connected repository (§15).
 *
 * Not one of §2's five nouns, and deliberately not folded into `apps`: a
 * repository is reached through one App *installation*, has one default branch,
 * and can lose access — three facts that belong to the repository and would have
 * to be repeated on, and kept consistent across, every App that names it. A
 * monorepo with four Apps in four subpaths is one row here and four there.
 *
 * **No per-repository credential column.** What is stored here is the
 * installation identity GitHub reported. The installation-level OAuth
 * credential lives in the encrypted singleton below, so connecting a second
 * repository never copies or specializes a bearer token.
 */
export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `owner/name` — the only handle the repository API takes. */
    fullName: text('full_name').notNull(),
    /**
     * Which installation of the GitHub App reaches it. A string because the
     * far side's numeric id is an opaque handle here, not an integer core does
     * arithmetic on.
     */
    installationId: text('installation_id').notNull(),
    /** §15: only the default branch is authoritative, so it is stored, not assumed. */
    defaultBranch: text('default_branch').notNull(),
    /**
     * §15: "**only its default-branch merge push becomes authoritative**."
     *
     * This is the commit whose configuration Spindrift has adopted — never a PR
     * head, never a branch tip it merely observed. It stays null until a
     * default-branch commit has actually been reconciled, which is what makes
     * "an unmerged PR changes nothing" a fact about a column rather than a
     * promise about a code path.
     */
    authoritativeCommit: text('authoritative_commit'),
    /** The configuration pull request this connection opened, once it exists. */
    configPullRequest: integer('config_pull_request'),
    access: repositoryAccess('access').notNull().default('active'),
    /** Set exactly when `access = 'frozen'`; the sentence an operator reads. */
    frozenReason: text('frozen_reason'),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    /** When the repo loop last completed a pass against it. */
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Connecting a repository twice must re-adopt the existing row rather than
    // produce a second one: two rows for one repository would each reconcile it,
    // and the loop would race itself over one authoritative commit.
    unique('repositories_full_name_unique').on(table.fullName),
    check(
      'repositories_frozen_has_reason',
      sql`(${table.access} = 'frozen') = (${table.frozenReason} is not null)`,
    ),
  ],
);

/**
 * The installation's GitHub user authorization.
 *
 * One row because a Spindrift installation has one repository connector, just
 * as it has one installation manifest. The credential is recoverable by
 * design—background reconciliation and hosted builds need it after the browser
 * ceremony ends—so unlike a session token it cannot be hashed. It is instead an
 * AES-GCM envelope whose key lives in the installation Secret. The key id in
 * that envelope supports additive rotation; `github/oauth.ts` rewrites a value
 * encrypted by a legacy key when it next reads it.
 *
 * Access and refresh tokens remain inside `encryptedCredential`. Keeping them
 * in one envelope makes GitHub's refresh-token rotation atomic: nobody can
 * observe a new access token paired with the refresh token it invalidated.
 */
export const githubOAuthCredentials = pgTable(
  'github_oauth_credentials',
  {
    id: integer('id').primaryKey().default(1),
    githubUserId: text('github_user_id').notNull(),
    githubLogin: text('github_login').notNull(),
    encryptedCredential: text('encrypted_credential').notNull(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('github_oauth_credentials_singleton', sql`${table.id} = 1`),
  ],
);

/**
 * One in-progress GitHub Device Flow ceremony.
 *
 * The device code can be exchanged for the operator's credential after they
 * approve the user code, so it is encrypted with a distinct purpose from the
 * durable credential. The browser receives only the user code and this row's
 * opaque id. Binding the row to a Spindrift user prevents another authenticated
 * browser from polling or consuming somebody else's ceremony.
 */
export const githubDeviceAuthorizations = pgTable(
  'github_device_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    encryptedDeviceCode: text('encrypted_device_code').notNull(),
    verificationUri: text('verification_uri').notNull(),
    intervalSeconds: integer('interval_seconds').notNull(),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

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
  /**
   * The connected repository this App's scope lives in, when there is one.
   *
   * Nullable because an archive App has no repository and a repo App may have
   * been created before anyone connected its repository — §15 makes Git
   * integration a thing an operator turns on, not a precondition of authoring.
   * `restrict` rather than `cascade`: disconnecting a repository must never be
   * a way to delete an App, which is the same rule §15 states about Deploys.
   */
  repositoryId: uuid('repository_id').references(() => repositories.id, {
    onDelete: 'restrict',
  }),
  /** Set when `sourceKind = 'archive'`: the uploaded bundle's digest. */
  sourceArchiveDigest: text('source_archive_digest'),
  /**
   * The build route this App has asked to build on, or null for no opinion.
   *
   * §16 settles route selection as "the level is a threshold, then admin rank
   * wins", and this is the App's say inside that — it narrows the candidates
   * rather than overriding the threshold, so a route below the Target's minimum
   * is refused here exactly as it is refused anywhere else. Naming one is not a
   * way around a policy; it is a way to pick among the routes that already
   * cleared it.
   *
   * Null is not "no route". It is the state every App is in until someone says
   * otherwise, and it means rank order picks — which is the whole of the
   * behaviour before this column existed.
   *
   * A plain string and not a reference: §4 makes the set of routes an
   * installation's configuration, so a name here may well name a route that has
   * been retired. That is not an error and never was — `buildRouteCandidates`
   * already reports a named-but-absent route as unavailable, which is the
   * honest reading and the one an operator can act on.
   */
  buildRoute: text('build_route'),
  /**
   * Opt in to a Deploy dispatched from a push, with no operator at the
   * keyboard (§15's webhook, `src/reconciler/auto-deploy.ts`).
   *
   * `false` by default and on every App that predates this column: auto-deploy
   * changes what is live without being asked at that moment, so an App gets it
   * only by a developer turning it on, never by upgrading Spindrift.
   */
  autoDeploy: boolean('auto_deploy').notNull().default(false),
  /**
   * **No vessel column, deliberately.** An App has placements, and each
   * placement's Target is a surface on a vessel — that is the boundary the App
   * is in, and it is derivable. A column here could only be a second, unchecked
   * answer to the same question; the one that existed was written from
   * `cloud.homeVesselProject` at creation and read by nothing but two labels.
   * See `0025_drop_app_vessel_ref.sql`.
   */
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
    /**
     * The entrypoint this Component runs the image with, and the arguments it
     * runs it with — `null` for the image's own, which is what every row
     * written before these columns existed means.
     *
     * Nullable for the same reason `expose` and `schedule` above are: a field
     * that only some Components state, on the one Component table. Not
     * per-kind, though — a monolith's `web`, `worker` and `cleanup` are one
     * image run three ways, so a service and a job both have one.
     *
     * `jsonb` rather than `text[]` because an argv is a document core never
     * predicates on, and because that is what the pinned copy in
     * `deploys.desired` already is — one encoding for the two places the same
     * list lives, rather than an array here and a JSON list there.
     */
    command: jsonbDocument('command').$type<string[]>(),
    args: jsonbDocument('args').$type<string[]>(),
    /**
     * §9: network-serving Components carry a reach and an auth. The default is
     * the old `private` state, unchanged in meaning — reachable on the
     * operator's own network, behind the Target's authenticated edge.
     */
    reach: reachState('reach').notNull().default('private'),
    auth: authMode('auth').notNull().default('proxy'),
    /**
     * The placement of record: the Target this Component lives on, as a stored
     * fact rather than an inference over `componentTargetDesired`.
     *
     * The newest desired row could not answer this — every intent bumps its
     * pair's `updatedAt`, so a rollback or config-set addressed at a retired
     * pair made the old row newest and every reader followed it back. Only
     * `placeComponent` moves this; the first act that places a Component with
     * none (a creation draft, a first deploy) establishes it; and
     * `unplaceComponent` clears it when the pair it retires is this one.
     * Desired rows for other Targets are what still serves there, not where
     * the Component is.
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
    artifactRefs: jsonbDocument('artifact_refs').$type<string[]>(),
    status: buildStatus('status').notNull().default('PENDING'),
    /** §4: the base image digest this build started from, for provenance. */
    baseDigest: text('base_digest'),
    /** §4: "The build backend and its fidelity are visible on the Build." */
    runner: text('runner'),
    logFidelity: logFidelity('log_fidelity'),
    /**
     * Where this build can be watched on the backend that is running it.
     *
     * A column rather than a log line because of *when* it is needed. §4's
     * `LIVE_STATUS` means the text does not arrive until the run is over, so
     * the log is empty during the exact window a developer wants to go look —
     * a link inside it would land with the thing it was meant to substitute
     * for. Written when the run is discovered, it is readable for the whole of
     * the run.
     *
     * Null for a route that has no such place, which is the honest answer for
     * an in-cluster build and not a missing value to paper over.
     */
    runUrl: text('run_url'),
    /**
     * The sentence dispatch last refused this Build with, while it is still
     * PENDING.
     *
     * A refusal an operator can clear — no federation, no route, a Target
     * threshold no configured route meets — leaves the Build PENDING on
     * purpose, so that configuring the thing makes the next tick work without
     * anybody pressing Deploy again. The build loop runs once a second, so the
     * refusal recurs at that rate, and the sentence belongs on the attempt log
     * exactly once rather than once per tick.
     *
     * This column is what makes "exactly once" free. The Build row is already
     * selected at the top of every dispatch, so comparing against it costs no
     * query, and a refusal that has not changed writes nothing at all. It is a
     * ledger of what was last said, not the place it was said: the operator
     * reads the attempt log.
     *
     * Null whenever the Build is not waiting — never dispatched, claimed, or
     * closed out.
     */
    dispatchWaitingOn: text('dispatch_waiting_on'),
    /** §4: durable identity for the dispatch attempt running or that ran this build. */
    dispatchId: text('dispatch_id'),
    /** Timestamp when the current runner claimed the dispatch lease. */
    leasedAt: timestamp('leased_at', { withTimezone: true }),
    /** §16: the backend envelope plus the facts core verified from it. */
    provenance:
      jsonbDocument('provenance').$type<BackendProvenanceAssessment>(),
    /**
     * The concrete achieved level, normalized for policy queries.
     *
     * It is deliberately beside the full envelope: deploy admission must compare
     * every new intent with the Target's current threshold without teaching SQL
     * the shape of a SLSA document.
     */
    verifiedBuildLevel: integer('verified_build_level'),
    /** Core's one cosign record, written only after provenance passes (§16). */
    signature: jsonbDocument('signature').$type<CoreSignature>(),
    /**
     * The unsigned BuildKit materials document attached to the artifact.
     *
     * Raw evidence dies with the registry object; this durable reference and the
     * normalized `baseDigest` preserve what core derived from it.
     */
    buildkitProvenanceRef: text('buildkit_provenance_ref'),
    /** SPDX evidence attached to the artifact; deliberately not assessed in v1. */
    sbomRef: text('sbom_ref'),
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
  debug: jsonbDocument('debug'),
  /**
   * §6: the adapter's own handle on what `apply` placed — "opaque to core,
   * which stores it and hands it back to `observe` and `destroy`." This column
   * is that storage. Null until an `apply` places something.
   */
  ref: text('ref'),
  url: text('url'),
  /**
   * §10: "a hash over a document of pinned version references."
   *
   * Kept beside {@link deploys.desired} rather than recomputed from it: this is
   * a materialized hash the UI reads on every list, not a second statement of
   * what is delivered.
   */
  configVersion: text('config_version'),
  /**
   * **What this intent places**, captured when it was written (§6, §10).
   *
   * `NOT NULL`, and that is the whole design. A Deploy whose meaning has to be
   * reassembled from Component and config rows that have moved since is not an
   * intent — it is a query, and it answers with today's shape under yesterday's
   * artifact. §10 already made this argument for config alone: "re-deriving it
   * from current config items would make every rollback come up with *today's*
   * config." The argument was never specific to config.
   *
   * So this column **replaces** `config_document`, `reach` and `auth`, which
   * pinned three fields of one document and left the rest to be re-read. Two
   * places holding one fact is two places for them to disagree.
   *
   * References, never values — the same posture as `sessions.tokenHash`: a
   * database that cannot produce a credential is a database whose disclosure
   * does not produce one either. See {@link DesiredDocument} for the three
   * fields this deliberately does not carry.
   */
  desired: jsonbDocument('desired').$type<DesiredDocument>().notNull(),
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
  /**
   * Why the platform will not converge on this release, in its own words.
   *
   * The digest answers "what is running instead"; this answers the case where
   * the digest is not the question. A delivery object can fail every reconcile
   * while the last good release keeps serving the desired digest — a chart
   * whose contract moved out from under stored values does exactly that — and
   * a drift flag with no sentence beside it tells an operator that something
   * is wrong without telling them it is unfixable by waiting.
   *
   * Not `detail`, which §6 reserves for a `FAILED` verdict. This Deploy did not
   * fail: it reached `LIVE` and the platform has since stopped agreeing.
   */
  driftDetail: text('drift_detail'),
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
export const datastores = pgTable(
  'datastores',
  {
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
     * The adapter's own handle on what it provisioned, opaque to core exactly
     * like `deploys.ref` (`adapters/datastore/contract.ts`: `DatastoreRef`).
     *
     * Stored rather than recomputed because `observe` and `destroy` both take
     * it as an argument and there is nowhere else to keep it. Re-deriving it
     * would mean core knowing that the Kubernetes adapter spells a handle
     * `<engine>/<namespace>/<name>` — a format that file declares opaque, and
     * that the cloud adapter does not share.
     *
     * Null until `provision` returns, which is what makes an `external`
     * Datastore — nothing was provisioned, so there is no handle — and a
     * `managed` row whose provision failed look the same to every reader that
     * has to decide whether an adapter call is owed.
     */
    ref: text('ref'),
    /**
     * §6's verdict on the datastore, in §6's own vocabulary.
     *
     * The same enum a Deploy carries, for the reason `contract.ts` already
     * argues for `DatastoreState`: "one shared vocabulary, not one per
     * contract — the user sees a single timeline and must not meet two
     * vocabularies along it."
     *
     * `PENDING` by default because the row is written *before* `provision` is
     * called — a name collision has to hit the unique key below before
     * anything exists in the cluster to collide with.
     */
    phase: deployPhase('phase').notNull().default('PENDING'),
    /**
     * The operator's sentence, as the datastore loop last read it.
     *
     * The one column a stuck datastore is diagnosed from: `phase` says
     * WAITING, and only this says whether that is a PVC nobody can bind or an
     * image still pulling. No `reason` beside it — a `FailureReason` with no
     * consumer would be a third column that can only agree with the second.
     */
    detail: text('detail'),
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
  },
  (table) => [
    // Two Datastores named `primary` on one Target are one object on the far
    // side: every adapter names what it provisions after the Datastore, and a
    // server-side apply of the second silently adopts the first. Destroying
    // either then deletes the other's storage. The constraint is here rather
    // than as a check in `createDatastore` because the race between two
    // concurrent creates is exactly what an application-level check cannot
    // win.
    //
    // Scoped to the Target, not the installation: §11 puts a Datastore on a
    // Target, so two clusters each holding a `primary` are two objects that
    // never meet.
    unique('datastores_target_name_unique').on(table.targetId, table.name),
  ],
);

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
/**
 * The tenancy boundary Targets are surfaces on (§13, §14).
 *
 * One row per place things deploy into — a cluster, a cloud project, later
 * whatever other tenancy container a provider offers. What lives here is every
 * fact that is
 * true of the boundary rather than of one runtime on it, which is what makes it
 * impossible for two surfaces to disagree about one of them. See
 * `src/domain/vessel.ts` for why this noun exists after §13 declined it.
 */
export const vessels = pgTable(
  'vessels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: vesselKind('kind').notNull(),
    /**
     * Where the boundary is, in its own kind's terms. Never a credential.
     *
     * Null for the same reason `targets.connection` is null: the manifest seeds
     * a vessel's identity and rank without necessarily stating how to reach it,
     * and that half-ready state is one §13 intends to be visible rather than
     * one to fabricate a value for. A Target is addressable exactly when its
     * own connection **and** its vessel's location are both present.
     */
    location: jsonbDocument('location').$type<VesselLocation>(),
    /** §33's reachability input, stated once for every surface on this vessel. */
    servedHosts: text('served_hosts').array(),
    /** §3, and boundary-shaped for the same reason. */
    reachableRegistries: text('reachable_registries').array(),
    /**
     * The standing checklist for the boundary itself, as
     * `VESSEL_PREREQUISITES_BY_KIND_AND_ROLE` decides its rows.
     *
     * Not a second copy of a Target's: these are the four facts that are true of
     * one boundary and of no runtime on it — the source bucket, the store
     * container, the artifacts project and the signer. Null means never
     * assessed, which is a different state from assessed-and-empty: an app
     * vessel is asked nothing and so stores an empty list once the loop has been
     * past it.
     *
     * Health is not a column. It is every catalogued row met, derived at read
     * time for the reason `target-loop.ts` gives — a stored derivation can be
     * stale in a way nothing notices.
     */
    prerequisites:
      jsonbDocument('prerequisites').$type<
        readonly VesselPrerequisiteResult[]
      >(),
    /** When the standing pass last ran against this boundary. */
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Connect is idempotent by name at the vessel level too: reconnecting a
    // project must reuse its vessel rather than minting a second one that its
    // surfaces would then be split across.
    unique('vessels_name_unique').on(table.name),
  ],
);

export const targets = pgTable(
  'targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adapter: targetAdapter('adapter').notNull(),
    /**
     * The boundary this Target is a surface on.
     *
     * `restrict` rather than `cascade`, matching `apps.repositoryId`: removing
     * a vessel must never be a way to delete the Targets that reference it,
     * and a vessel with live surfaces is not a vessel anyone meant to drop.
     */
    vesselId: uuid('vessel_id')
      .notNull()
      .references(() => vessels.id, { onDelete: 'restrict' }),
    status: targetStatus('status').notNull().default('connected'),
    /** §13: "set a global ordered rank across Targets." */
    rank: integer('rank').notNull(),
    /**
     * The **surface** half of how this Target is reached —
     * `TargetConnection` in `src/domain/target.ts`. Never a credential: §13
     * settles one auth mode, "native OIDC federation, nothing stored."
     *
     * Only facts true of this runtime and not of its neighbours on the same
     * vessel: a region, an API root, a namespace, a delivery flavour. Where the
     * boundary *is*, and what it can reach, belong to {@link vessels} — the
     * adapter still receives one flat view, composed by `deployTargetOf`.
     *
     * Null means the manifest has established the Target's identity and rank,
     * but neither desired state nor an operator has supplied connection facts.
     */
    connection: jsonbDocument('connection').$type<TargetConnection>(),
    /** §13: the standing checklist's last verdict. */
    health: targetHealth('health').notNull(),
    /** One `PrerequisiteResult` per item, with the sentence behind each. */
    prerequisites:
      jsonbDocument('prerequisites').$type<readonly PrerequisiteResult[]>(),
    /** §3's discovered half, as the adapter last reported it. */
    discovery: jsonbDocument('discovery').$type<TargetDiscovery>(),
    /** When the one loop (§13) last ran against this Target. */
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
    /**
     * §3's assertions, both for the reason §3 gives for the one it started
     * with: "no cluster API reports whether a tunnel exists." Nothing reports
     * whether an operator wired an authenticating proxy in front of you either,
     * so auth is the same shape.
     *
     * `reaches` widens what `publicExposure` said. Null on either means nobody
     * has stated it, and {@link ASSERTED_REACHES_BY_ADAPTER} supplies what the
     * adapter can be held to without an operator's word.
     */
    reaches: reachState('reaches').array(),
    /**
     * Which reaches this Target's authenticated edge can stand in front of —
     * **not** whether it has one. An edge whose audience is one person can
     * honestly authenticate a `private` route and cannot honestly authenticate
     * a `public` one, and that is a difference only an operator knows.
     */
    authReaches: reachState('auth_reaches').array(),
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
    // **A Target is its vessel and its surface**, and that pair is naturally
    // unique — a boundary carries one runtime of each kind. So there is no name
    // to construct, none to collide, and none to rename when a vessel turns out
    // to carry a surface nobody knew about. Connect is idempotent by this pair
    // for the reason it used to be idempotent by name: reconnecting re-adopts
    // rather than registering a second Target competing for the same workloads.
    unique('targets_vessel_adapter_unique').on(table.vesselId, table.adapter),
  ],
);

/**
 * §"First run and identity": an operator enrolls a passkey and gets a fully
 * privileged account; there is no role table in v1 because every enrolled
 * user is that one privileged kind. `gatewayIdentity` is the optional
 * linked identity from the front-door Gateway, kept distinct from
 * Spindrift's own user model on purpose.
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
    // One trusted identity cannot name two internal users, even if v1 normally
    // has only the operator. Keep the invariant where later multi-user work
    // cannot accidentally weaken it.
    unique('users_gateway_identity_unique').on(table.gatewayIdentity),
  ],
);

/**
 * One in-progress Source → Component → Place → Configure → Review flow.
 *
 * The JSON document is replaced atomically under `revision`; a stale browser
 * cannot silently overwrite a newer tab. Ownership is the authenticated User,
 * not a browser token, so a refreshed session resumes the same identity.
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
 * One enrolled passkey (§"First run and identity" story 1).
 *
 * Both stored halves come from the browser's own parse of the attestation
 * response — `publicKey` is SPKI from `getPublicKey()`, `algorithm` is the COSE
 * id it reported — which is what lets `src/auth/webauthn.ts` exist without a
 * CBOR decoder. That module's header carries why that is sound; the short form
 * is that the enrolment token is the trust anchor, not the authenticator.
 *
 * `signCount` is stored because WebAuthn defines a clone check over it, and is
 * expected to stay `0` forever: a synced passkey has nothing to count. The
 * check binds only when an authenticator is actually counting.
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
    /** SPKI, base64url. A public key: this is not a secret. */
    publicKey: text('public_key').notNull(),
    /** COSE algorithm id — `-7` (ES256) or `-257` (RS256). */
    algorithm: integer('algorithm').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    // A credential id is the handle a sign-in arrives with, so it must name at
    // most one row — a duplicate would make "whose passkey is this" ambiguous
    // at exactly the moment it has to be answered.
    unique('credentials_credential_id_unique').on(table.credentialId),
  ],
);

/**
 * §"First run and identity" story 3: "an opaque session that lasts a day, so
 * that a stolen browser artifact is not a permanent credential."
 *
 * **The token is not here.** Only its SHA-256 is, which is the same posture
 * §10 takes with config values and for the same reason: a database that cannot
 * produce a credential is a database whose disclosure does not produce one
 * either. A session is looked up by hashing what the cookie presented, never by
 * comparing against something stored.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque cookie value, base64url. Never the value itself. */
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [unique('sessions_token_hash_unique').on(table.tokenHash)],
);

/**
 * §"First run and identity" story 2: "the enrolment token consumed on use, so
 * that the window in which anyone else could claim my installation closes the
 * moment I finish."
 *
 * Consumption is a row rather than a flag on a token, because Spindrift never
 * held the token in the first place — it arrives in the installation Secret and
 * is read from the environment. What core owns is the *fact that this one has
 * been spent*, and the unique index is what makes spending it twice impossible
 * rather than merely checked.
 *
 * Story 4 falls out of the same row: recovery is "rotate the token and replace
 * every passkey", so a token whose hash is not already here is a new token, and
 * consuming it clears the credentials that came before it. Rotating the Secret
 * *is* the recovery, with no second act to remember.
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
 * A challenge issued for one WebAuthn ceremony, and spent by it.
 *
 * A table rather than a signed cookie, because the property being bought is
 * single use: a cookie proves the server issued the challenge and cannot prove
 * it has not already been answered. Deleting the row on use is what makes a
 * captured ceremony worthless the second time, and it is checkable at the same
 * seam every other claim here is.
 */
export const webauthnChallenges = pgTable('webauthn_challenges', {
  /** The random value, base64url. */
  challenge: text('challenge').primaryKey(),
  /** Which ceremony it was issued for: an enrolment or a sign-in. */
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
     * §10: "Values are write-only." Set only when `kind = 'secret_ref'`: the
     * store's own name for the item, exactly as `put` minted it — a pointer
     * into the connected store, never a value.
     */
    storeRef: text('store_ref'),
    /**
     * The version pinned, beside the item it is a version of.
     *
     * Two columns rather than one encoded reference because §10's pin is the
     * half that has to be *compared*: `configVersion` is a hash over these, a
     * reaper reads them to know what is still delivered, and a delimiter chosen
     * here would be a delimiter some store's item name is allowed to contain.
     */
    storeVersion: text('store_version'),
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

/**
 * §10: "auditing is metadata-only" — story 80's "who changed which key when,
 * so that history is useful without becoming a secret store".
 *
 * A second table rather than an `updatedBy` column on the item, because the
 * question is a history and a column answers only the last edit. **There is no
 * value column and there is no room for one**: what a row says is that a key
 * changed, not what it changed to or from — core could not fill a value column
 * if it wanted to, since it never reads one back (§10).
 *
 * `userId` survives the user: an audit trail that deleted itself when an
 * operator was removed would lose exactly the history somebody is looking for.
 */
export const configAction = pgEnum('config_action', ['set', 'removed']);

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
  /** Kept beside the id so the trail reads as "who, which key, when". */
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

/**
 * One registry's push credential, sealed (§16).
 *
 * **Keyed on the host and not on the declared namespace**, because the host is
 * what the credential is actually for: a registry login authenticates a
 * *registry*, and the Docker config a builder reads has one `auths` entry per
 * host. Keying on the namespace would let an operator set two different
 * credentials for `ghcr.io/a` and `ghcr.io/b` and then silently honour one of
 * them, which is a promise the mechanism cannot keep.
 *
 * `secret` is a `credential-envelope.ts` envelope, never the token — the same
 * boundary and the same keyring the GitHub OAuth row uses, so a rotation
 * covers both. Nothing above the seam returns it: it is opened at dispatch and
 * handed to the route that pushes, and no command reads it back.
 *
 * The username is plain because it is not a secret and is the half an operator
 * has to be able to see to know which account is configured — Docker Hub and
 * Artifact Registry both take a fixed one (`_json_key`, `oauth2accesstoken`)
 * and a listing that hid it would make a wrong one undiagnosable.
 */
export const registryCredentials = pgTable('registry_credentials', {
  /** The registry host, exactly as `registryHostOf` reads it off a namespace. */
  host: text('host').primaryKey(),
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
 * The bosun build route's outbox (Task: bosun build route).
 *
 * Bosun is a warm-pool microVM runner daemon this process cannot reach — it
 * long-polls in, rather than being dialed the way the in-cluster Job or the
 * hosted dispatch are. An outbox row is the queue entry that makes that
 * direction of contact possible: `enqueue` writes one, a bosun host claims it
 * over `POST /internal/bosun/claim`, and `complete` is the same row's last
 * write. `src/storage/build-outbox.ts` is the seam; this table is only ever
 * read or written through it.
 *
 * `lease_expires` is what makes a claim revocable without a second actor —
 * `builds.leased_at` is the precedent (a claimed dispatch that stops
 * heartbeating is eventually reclaimed), except here reclamation is a plain
 * `UPDATE ... WHERE state = 'CLAIMED' AND lease_expires < now()` rather than a
 * comparison against a fixed timeout, because the poller extends it itself on
 * every heartbeat.
 *
 * `result` lands only once, `iff state != 'DONE'` — a late result from a
 * lease-expired claimant that got superseded still lands if nothing else
 * claimed the row in between, because a real result beats a rerun.
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
    leaseExpires: timestamp('lease_expires', { withTimezone: true }),
    /** `null` until `complete` writes it; also `null` for a cancelled request. */
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

// --- Relations (query-builder convenience; no schema effect) ---------------

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
  target: one(targets, {
    fields: [datastores.targetId],
    references: [targets.id],
  }),
}));

export const targetsRelations = relations(targets, ({ one, many }) => ({
  vessel: one(vessels, {
    fields: [targets.vesselId],
    references: [vessels.id],
  }),
  deploys: many(deploys),
  datastores: many(datastores),
}));

export const vesselsRelations = relations(vessels, ({ many }) => ({
  targets: many(targets),
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

// --- Row types ---------------------------------------------------------

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
