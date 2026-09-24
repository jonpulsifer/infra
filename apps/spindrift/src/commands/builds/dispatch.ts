/**
 * Runs one Build through one build route. Success writes a digest onto the Build
 * and nothing else, so a late build moves nothing live. Logs are read from the
 * route's events; nothing is exposed for a builder to post back to.
 */
import { and, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type {
  BuildAdapter,
  BuildSource,
  BuildSpec,
} from '../../adapters/build/contract.ts';
import type { FailureReason } from '../../adapters/deploy/contract.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  repositories,
  targets,
  vessels,
} from '../../db/schema.ts';
import {
  artifactTags,
  componentRepositories,
  publishableRegistries,
  registryFlavour,
  registryHostOf,
} from '../../domain/artifact-name.ts';
import {
  type BuildAttemptRef,
  recordBuildEvent,
} from '../../domain/attempt-log.ts';
import {
  buildRouteCandidates,
  DEFAULT_MINIMUM_BUILD_LEVEL,
} from '../../domain/build-route.ts';
import { vercelFrameworkOf } from '../../domain/detection/declared.ts';
import { parseSpindriftFile } from '../../domain/detection/spindrift-file.ts';
import { DEFAULT_PLATFORM } from '../../domain/placement.ts';
import { repositoryRefOf } from '../../domain/repository.ts';
import { buildOriginOf, type Source } from '../../domain/source.ts';
import { targetLabel } from '../../domain/target.ts';
import { SPINDRIFT_FILE } from '../../integrations/github/config-pr.ts';
import { isFetchableBundleLocation } from '../../storage/archives.ts';
import { parseGcsLocation, signedObjectUrl } from '../../storage/signed-url.ts';
import { reconcilerDispatchAttempts } from '../../telemetry/index.ts';
import { isBuildTimeConfig, readBuildArgs } from '../config/build-args.ts';
import {
  declaredBuildSecrets,
  resolveBuildSecrets,
} from '../config/build-secrets.ts';
import {
  type CommandContext,
  type CommandFailureCode,
  type CommandResult,
  failed,
  ok,
} from '../types.ts';

/** Stops one App's push loop from taking every runner an installation has. */
export const CONCURRENT_BUILDS_PER_APP = 3;

/** A RUNNING build whose lease is older than this reads as abandoned. */
export const DISPATCH_LEASE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A quarter of the timeout, so a renewal can miss twice before the row reads as
 * abandoned.
 */
export const DISPATCH_LEASE_REFRESH_MS = DISPATCH_LEASE_TIMEOUT_MS / 4;

/**
 * The first refusal waits a second and each one after doubles it, up to five
 * minutes, so an operator's fix is picked up soon. A fresh press resets the clock.
 */
export const DISPATCH_BACKOFF_BASE_MS = 1_000;
export const DISPATCH_BACKOFF_CAP_MS = 5 * 60 * 1000;

/** The wait a row's next attempt earns after `attempts` consecutive refusals. */
export function dispatchBackoffMs(attempts: number): number {
  return Math.min(
    DISPATCH_BACKOFF_CAP_MS,
    DISPATCH_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
  );
}

export const dispatchBuildInput = z
  .object({
    buildId: z.number().int().positive(),
    /** A route name core does not interpret: the registry resolves it. */
    route: z.string().trim().min(1),
    /**
     * The placement this build is for: its minimum build level, build secrets and
     * a website's build args. Defaults to the only placement when there is one.
     * The Build key has no Target, so same-shape Targets with different website
     * build args share one artifact.
     */
    placementTargetId: z.uuid().optional(),
    /**
     * Generated when omitted. A UUID, because routes name their far side by it:
     * the outbox row's key, the in-cluster Job's name.
     */
    dispatchId: z.uuid().optional(),
  })
  .strict();

export type DispatchBuildInput = z.infer<typeof dispatchBuildInput>;

export interface DispatchBuildResult {
  readonly buildId: number;
  readonly status: 'SUCCEEDED' | 'FAILED';
  /** Null unless the build succeeded. */
  readonly artifactDigest: string | null;
  /** The route that ran. */
  readonly runner: string;
  readonly dispatchId: string;
}

export type BuildDispatchContext = Pick<
  CommandContext,
  'db' | 'adapters' | 'clock' | 'manifest'
>;

interface TargetBuildPolicy {
  readonly name: string;
  readonly minimumLevel: 1 | 2 | 3;
}

async function targetBuildPolicy(
  context: Pick<CommandContext, 'db'>,
  targetId: string | undefined,
): Promise<TargetBuildPolicy | null> {
  if (targetId === undefined) return null;
  const [target] = await context.db
    .select({
      vessel: vessels.name,
      adapter: targets.adapter,
      minBuildLevel: targets.minBuildLevel,
    })
    .from(targets)
    .innerJoin(vessels, eq(vessels.id, targets.vesselId))
    .where(eq(targets.id, targetId));
  if (target === undefined) return null;
  return {
    name: targetLabel(target),
    minimumLevel: (target.minBuildLevel ?? DEFAULT_MINIMUM_BUILD_LEVEL) as
      | 1
      | 2
      | 3,
  };
}

/**
 * Checked before starting: a build below the Target's minimum level would succeed
 * and then be refused at admission. With no placement named, there is no threshold.
 */
function routeRefusedByTarget(
  policy: TargetBuildPolicy | null,
  adapter: BuildAdapter,
): string | null {
  if (policy === null) return null;
  const [candidate] = buildRouteCandidates(
    [{ name: adapter.name, level: adapter.buildLevel }],
    { minimumLevel: policy.minimumLevel },
  );
  return candidate === undefined || candidate.eligible
    ? null
    : `${policy.name} will not take a build from ${adapter.name}: ${candidate.reason}`;
}

/**
 * A `gs://` depot address becomes a short-lived signed URL, because a hosted
 * runner holds no cloud credential. Any other unfetchable location is refused.
 */
async function fetchableBundleLocation(
  context: Pick<BuildDispatchContext, 'manifest'>,
  app: Pick<typeof apps.$inferSelect, 'name' | 'sourceKind'>,
  location: string,
): Promise<CommandResult<string>> {
  if (parseGcsLocation(location) === null) {
    if (isFetchableBundleLocation(location)) return ok(location);
    // A repository can be staged again; an archive can only be uploaded again.
    const remedy =
      app.sourceKind === 'repo'
        ? `deploy ${app.name} again to stage a fresh bundle from its repository`
        : `upload ${app.name}'s archive again to stage it in the depot`;
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s staged bundle is at ${location}, which names this installation's own disk rather than anything a build route can fetch — ${remedy}`,
    );
  }

  const federation = context.manifest?.cloud?.federation ?? null;
  if (federation === null) {
    return failed(
      'NOT_BUILDABLE',
      `the staged bundle is in cloud storage and this installation configures no federation to reach it, so no route could fetch ${location}`,
    );
  }

  try {
    return ok(await signedObjectUrl({ location, federation }));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // The object path, never the URL: a signed URL is a bearer capability, and
    // this sentence reaches the attempt log.
    return failed(
      'NOT_BUILDABLE',
      `could not mint a signed URL for the staged bundle at ${location}, so no route could fetch it: ${detail}`,
    );
  }
}

/**
 * `null` is fatal: with no framework named, the platform builds the scope as
 * plain files and serves an SSR app's sources, so dispatch refuses it.
 */
async function vercelFrameworkFor(
  context: Pick<CommandContext, 'adapters'>,
  input: {
    readonly artifactType: BuildSpec['artifactType'];
    readonly source: Source;
    readonly repository: {
      readonly installationId: string;
      readonly fullName: string;
    } | null;
  },
): Promise<string | null> {
  if (input.artifactType !== 'vercel-output') return null;
  if (input.source.kind !== 'repo') return null;
  if (input.repository === null) return null;
  const host = context.adapters.repository();
  if (host === null) return null;

  const path =
    input.source.subpath === '.'
      ? 'package.json'
      : `${input.source.subpath}/package.json`;

  let manifest: string | null;
  try {
    manifest = await host.readFile(
      repositoryRefOf(input.repository),
      input.repository.fullName,
      input.source.commit,
      path,
    );
  } catch {
    return null;
  }
  if (manifest === null) return null;
  return vercelFrameworkOf(manifest);
}

/**
 * Read from the scope's `SPINDRIFT_FILE` at this build's commit. Every unknown
 * answers `null`, which ships the scope as it stands.
 */
async function outputDirectoryFor(
  context: Pick<CommandContext, 'adapters'>,
  input: {
    readonly artifactType: BuildSpec['artifactType'];
    readonly source: Source;
    readonly repository: {
      readonly installationId: string;
      readonly fullName: string;
    } | null;
  },
): Promise<string | null> {
  if (input.artifactType !== 'files') return null;
  // An upload has no repository to read the file from.
  if (input.source.kind !== 'repo') return null;
  if (input.repository === null) return null;
  const host = context.adapters.repository();
  if (host === null) return null;

  const path =
    input.source.subpath === '.'
      ? SPINDRIFT_FILE
      : `${input.source.subpath}/${SPINDRIFT_FILE}`;

  let document: string | null;
  try {
    document = await host.readFile(
      repositoryRefOf(input.repository),
      input.repository.fullName,
      input.source.commit,
      path,
    );
  } catch {
    return null;
  }
  if (document === null) return null;

  try {
    const proposal = parseSpindriftFile(document, path);
    return proposal.build.frontend === 'railpack'
      ? proposal.build.outputDirectory
      : null;
  } catch {
    return null;
  }
}

/**
 * `runBuildPass` drops every refusal, so each one is recorded. `closes` fails the
 * Build over a fact about the row; `waits` keeps it PENDING for an operator's fix.
 */
type RefusalDisposition =
  | { readonly kind: 'closes'; readonly reason: FailureReason }
  | { readonly kind: 'waits' };

export interface RefusalSubject {
  readonly attempt: BuildAttemptRef;
  /** `builds.dispatchWaitingOn` as it stands, for suppressing a repeat. */
  readonly waitingOn: string | null;
  /** `builds.dispatchAttempts` as it stands, for pacing the next attempt. */
  readonly attempts: number;
  /** Set for a refusal made after the claim, so its write is fenced on it. */
  readonly dispatchId?: string;
}

/** Logged, so a run that lost its claim mid-stream does not read as a hang. */
const LOST_CLAIM_SENTENCE =
  'this dispatch lost its claim to another reconciler and wrote nothing; ' +
  'the attempt that holds the claim reports what happened';

/**
 * `failed`, never `ok`: `runBuildPass` auto-deploys on a SUCCEEDED result, which
 * would ship a build another attempt has superseded.
 */
async function lostClaim<Output>(
  context: Pick<BuildDispatchContext, 'db'>,
  attempt: BuildAttemptRef,
): Promise<CommandResult<Output>> {
  await recordBuildEvent(context.db, attempt, {
    type: 'log',
    line: LOST_CLAIM_SENTENCE,
    resource: 'dispatch',
  });
  reconcilerDispatchAttempts.add(1, { outcome: 'lost' });
  return failed('NOT_BUILDABLE', LOST_CLAIM_SENTENCE);
}

async function refuseDispatch<Output>(
  context: Pick<BuildDispatchContext, 'db' | 'clock'>,
  subject: RefusalSubject,
  code: CommandFailureCode,
  sentence: string,
  disposition: RefusalDisposition,
): Promise<CommandResult<Output>> {
  if (disposition.kind === 'closes') {
    const closed = await recordDispatchClose(
      context,
      subject,
      sentence,
      disposition.reason,
    );
    if (!closed) return lostClaim(context, subject.attempt);
    return failed(code, sentence);
  }

  await recordDispatchWait(context, subject, sentence);
  return failed(code, sentence);
}

/**
 * Exported for `runBuildPass`, which closes a Build whose shape its placement no
 * longer takes. Returns `false` when the fenced write matched no row.
 */
export async function recordDispatchClose(
  context: Pick<BuildDispatchContext, 'db'>,
  subject: RefusalSubject,
  sentence: string,
  reason: FailureReason,
): Promise<boolean> {
  // The row before the log: a refusal under a claim may find the row gone, and
  // its sentence must not land on another attempt's log.
  const closed = await context.db
    .update(builds)
    // A FAILED Build is waiting on nothing.
    .set({ status: 'FAILED', dispatchWaitingOn: null })
    .where(
      subject.dispatchId === undefined
        ? eq(builds.id, subject.attempt.buildId)
        : and(
            eq(builds.id, subject.attempt.buildId),
            eq(builds.dispatchId, subject.dispatchId),
          ),
    )
    .returning({ id: builds.id });
  if (subject.dispatchId !== undefined && closed.length === 0) return false;
  await recordBuildEvent(context.db, subject.attempt, {
    type: 'log',
    line: sentence,
    resource: 'dispatch',
  });
  await recordBuildEvent(context.db, subject.attempt, {
    type: 'status',
    phase: 'FAILED',
    reason,
  });
  reconcilerDispatchAttempts.add(1, { outcome: 'closed' });
  return true;
}

/**
 * Logs a new sentence once and advances the backoff on every call. Exported for
 * `runBuildPass`, which refuses a Build with no placement or no admitted route.
 */
export async function recordDispatchWait(
  context: Pick<BuildDispatchContext, 'db' | 'clock'>,
  subject: RefusalSubject,
  sentence: string,
): Promise<void> {
  if (subject.waitingOn !== sentence) {
    await recordBuildEvent(context.db, subject.attempt, {
      type: 'log',
      line: sentence,
      resource: 'dispatch',
    });
  }
  const attempts = subject.attempts + 1;
  const now = context.clock?.now() ?? new Date();
  await context.db
    .update(builds)
    .set({
      dispatchWaitingOn: sentence,
      dispatchAttempts: attempts,
      nextDispatchAt: new Date(now.getTime() + dispatchBackoffMs(attempts)),
    })
    .where(eq(builds.id, subject.attempt.buildId));
  reconcilerDispatchAttempts.add(1, { outcome: 'waiting' });
}

export const dispatchBuild = async (
  input: DispatchBuildInput,
  context: BuildDispatchContext,
): Promise<CommandResult<DispatchBuildResult>> => {
  const [build] = await context.db
    .select()
    .from(builds)
    .where(eq(builds.id, input.buildId));
  if (build === undefined) {
    return failed('NOT_FOUND', `there is no Build with id ${input.buildId}`);
  }

  const [component] = await context.db
    .select()
    .from(components)
    .where(eq(components.id, build.componentId));
  if (component === undefined) {
    return failed(
      'NOT_FOUND',
      `Build ${build.id} names a Component that no longer exists`,
    );
  }

  const [app] = await context.db
    .select()
    .from(apps)
    .where(eq(apps.id, component.appId));
  if (app === undefined) {
    return failed(
      'NOT_FOUND',
      `Component ${component.id} names an App that no longer exists`,
    );
  }
  const [repository] =
    app.repositoryId === null
      ? []
      : await context.db
          // `installationId` rides along for the file reads at this build's commit.
          .select({
            fullName: repositories.fullName,
            installationId: repositories.installationId,
          })
          .from(repositories)
          .where(eq(repositories.id, app.repositoryId))
          .limit(1);

  // A supplied artifact is already the artifact. Running a route would digest the
  // same bytes a second time.
  if (build.status === 'SUCCEEDED' && build.artifactDigest !== null) {
    return ok({
      buildId: build.id,
      status: 'SUCCEEDED' as const,
      artifactDigest: build.artifactDigest,
      runner: build.runner ?? 'supplied',
      dispatchId: build.dispatchId ?? input.dispatchId ?? 'supplied',
    });
  }

  // Every refusal below goes through `refuseDispatch`, because `runBuildPass`
  // drops an unrecorded one.
  const subject: RefusalSubject = {
    attempt: {
      appId: app.id,
      componentId: component.id,
      buildId: build.id,
    },
    waitingOn: build.dispatchWaitingOn,
    attempts: build.dispatchAttempts,
  };

  if (build.bundleDigest === null) {
    // The bundle digest joins the source receipt to the provenance, and no tick
    // stages one: staging happens where the Build is created.
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `Build ${build.id} has no staged bundle, so no route can be given one`,
      { kind: 'closes', reason: 'ARTIFACT_UNAVAILABLE' },
    );
  }

  const adapter = context.adapters.build(input.route);
  if (adapter === null) {
    // A missing route is configuration, so the next tick dispatches once it exists.
    return refuseDispatch(
      context,
      subject,
      'NOT_FOUND',
      `this installation has no build route named ${input.route}, so nothing can run this Build until one is configured`,
      { kind: 'waits' },
    );
  }

  // With several placements, dispatch must name one; with one, it is the default.
  const placements = await context.db
    .select({ targetId: componentTargetDesired.targetId })
    .from(componentTargetDesired)
    .where(eq(componentTargetDesired.componentId, component.id));

  let effectiveTargetId = input.placementTargetId;
  if (effectiveTargetId !== undefined) {
    if (
      placements.length > 0 &&
      !placements.some((p) => p.targetId === effectiveTargetId)
    ) {
      // `waits`: the remedy is a placement, not a rebuild.
      return refuseDispatch(
        context,
        subject,
        'NOT_BUILDABLE',
        `Target ${effectiveTargetId} is not a placement target for Component ${component.id}`,
        { kind: 'waits' },
      );
    }
  } else {
    if (placements.length === 1) {
      effectiveTargetId = placements[0]!.targetId;
    } else if (placements.length > 1) {
      return refuseDispatch(
        context,
        subject,
        'NOT_BUILDABLE',
        `Component ${component.id} has multiple target placements, so dispatch must name an explicit placementTargetId`,
        { kind: 'waits' },
      );
    }
  }

  // The Target's minimum level applies only where a placement is named. `waits`,
  // because the threshold and the offered routes are both configuration.
  const targetPolicy = await targetBuildPolicy(context, effectiveTargetId);
  const refusal = routeRefusedByTarget(targetPolicy, adapter);
  if (refusal !== null) {
    return refuseDispatch(context, subject, 'NOT_BUILDABLE', refusal, {
      kind: 'waits',
    });
  }

  // A missing location would reach a route as an empty URL.
  if (build.bundleLocation === null) {
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `Build ${build.id} has no staged bundle location, so no route can fetch it`,
      { kind: 'closes', reason: 'ARTIFACT_UNAVAILABLE' },
    );
  }

  const attempt = subject.attempt;

  // A Build is keyed on a shape, not a Target, so its destinations are the
  // installation's registries. A route never picks its own.
  const allRegistries = context.manifest.supplyChain.registry;
  /**
   * Only the registries this route can authorize a push to: one unauthorized
   * destination fails the whole export. Stored credentials widen the set.
   */
  const storedHosts = new Set(
    (await context.adapters.registryCredentials?.()?.list())?.map(
      (one) => one.host,
    ) ?? [],
  );
  const registries = publishableRegistries({
    registries: allRegistries,
    selfAuthorized: adapter.selfAuthorizedRegistries,
    storedHosts,
  });
  if (registries.length === 0) {
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `the "${adapter.name}" route can authorize a push to none of the ` +
        `registries this installation publishes to (${allRegistries.join(', ')}), ` +
        'so a build on it would have nowhere to put the artifact. Store a ' +
        'registry credential for one of them, or build on a route whose own ' +
        'identity reaches one.',
      // Both halves are configuration an operator can supply.
      { kind: 'waits' },
    );
  }
  const destinations = componentRepositories({
    registries,
    app: app.name,
    component: component.name,
  });
  if (destinations === null) {
    const sentence =
      `App "${app.name}" / Component "${component.name}" cannot name a ` +
      `repository under ${registries.join(' or ')}: a registry ` +
      `path segment is lowercase alphanumerics separated by "-", "_" or "."`;
    // A name no registry accepts is an invalid spec, and the developer can rename it.
    return refuseDispatch(context, subject, 'NOT_BUILDABLE', sentence, {
      kind: 'closes',
      reason: 'REJECTED',
    });
  }

  // The stored location, not a fetchable one: the signed URL is minted after the
  // claim, so a refused attempt spends no signature.
  const source: Source =
    app.sourceKind === 'repo'
      ? {
          kind: 'repo',
          url: repository?.fullName ?? app.sourceRepoUrl ?? '',
          // The real commit, never the row's `<commit>#<millis>` rerun key: files
          // are read at this ref, and the far side cannot resolve a suffixed one.
          commit: build.commit.split('#')[0] ?? build.commit,
          subpath: app.sourceRepoSubpath ?? '.',
          location: build.bundleLocation,
        }
      : {
          kind: 'archive',
          digest: build.bundleDigest,
          location: build.bundleLocation,
          contents: 'source',
          // Per Build, because the unwrap depends on the uploaded bytes.
          subpath: build.bundleSubpath ?? '.',
        };

  /**
   * Opened here only. Plaintext credentials reach exactly one route and are never
   * written to the Build row, the attempt log or an event.
   */
  const credentials = context.adapters.registryCredentials?.() ?? null;
  /**
   * A route that carries credentials asks for every destination, since the run's
   * own token may not write there. Others ask only for hosts they cannot authorize.
   */
  const destinationHosts = [...new Set(destinations.map(registryHostOf))];
  const unauthorizedHosts = destinationHosts.filter(
    (host) => !adapter.selfAuthorizedRegistries.includes(registryFlavour(host)),
  );
  const registryAuth =
    (await credentials?.authFor(
      adapter.carriesHeldSecret ? destinationHosts : unauthorizedHosts,
    )) ?? [];

  // Refused before the claim, so no credential goes where the route puts its
  // inputs. `waits`: a different route or a removed credential clears it.
  if (registryAuth.length > 0 && !adapter.carriesHeldSecret) {
    const hosts = registryAuth.map((one) => one.host).join(', ');
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `this installation holds a registry credential for ${hosts}, and the ` +
        `"${adapter.name}" route cannot carry one — its dispatch inputs are ` +
        'readable by anyone who can see the run. Admit a route that runs the ' +
        'build in a container of its own, or remove the credential if that ' +
        'registry does not need one.',
      { kind: 'waits' },
    );
  }

  // Build secrets need the same capability as a registry credential. Names are
  // checked first, so no plaintext is resolved for a route that cannot carry it.
  const buildSecretNames =
    effectiveTargetId === undefined
      ? []
      : await declaredBuildSecrets(context, component.id, effectiveTargetId);
  if (buildSecretNames.length > 0 && !adapter.carriesHeldSecret) {
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `${component.name} declares build secrets (${buildSecretNames.join(', ')}), ` +
        `and the "${adapter.name}" route cannot carry one — its dispatch ` +
        'inputs are readable by anyone who can see the run. Admit a route ' +
        'that runs the build in a container of its own, or remove the ' +
        'declarations if the build no longer needs them.',
      { kind: 'waits' },
    );
  }
  // Opened here only, like the registry credential. The row records the names.
  let buildSecrets: BuildSpec['buildSecrets'] = [];
  if (buildSecretNames.length > 0 && effectiveTargetId !== undefined) {
    const resolved = await resolveBuildSecrets(
      context,
      component.id,
      effectiveTargetId,
    );
    if ('refusal' in resolved) {
      return refuseDispatch(
        context,
        subject,
        'NOT_BUILDABLE',
        resolved.refusal,
        {
          kind: 'waits',
        },
      );
    }
    buildSecrets = resolved.secrets;
  }

  const spec: BuildSpec = {
    artifactType: build.artifactType,
    kind: component.kind,
    platform: DEFAULT_PLATFORM,
    destinations,
    registryAuth,
    buildSecrets,
    /**
     * Retention counts tags, so a push carrying only the implicit `:latest` would
     * leave a rollback depth of one.
     */
    tags: artifactTags(build.bundleDigest),
    /**
     * Read here, never by the route, so a value reaches a builder in one place.
     * A website's build args are plain rows, never store values.
     */
    buildArgs:
      effectiveTargetId === undefined || !isBuildTimeConfig(component.kind)
        ? {}
        : await readBuildArgs(context.db, component.id, effectiveTargetId),
    /** A website on a static Target ships the files its build leaves behind. */
    outputDirectory: await outputDirectoryFor(context, {
      artifactType: build.artifactType,
      source,
      repository: repository ?? null,
    }),
    vercelFramework: await vercelFrameworkFor(context, {
      artifactType: build.artifactType,
      source,
      repository: repository ?? null,
    }),
  };

  // Refused here: with no framework the build goes green and serves the sources.
  // `waits`, because adding the dependency makes the next tick work.
  if (spec.artifactType === 'vercel-output' && spec.vercelFramework === null) {
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `${component.name} is placed on a Vercel Target, which builds through the platform's own framework builder — and nothing in this scope's package.json names a framework Spindrift recognises. Vercel performs no detection of its own: a build with no framework is built as a plain directory of files and would serve this project's sources with no functions at all, so it is refused instead.`,
      { kind: 'waits' },
    );
  }

  const dispatchId = input.dispatchId ?? crypto.randomUUID();
  const now = context.clock?.now() ?? new Date();
  const leaseCutoff = new Date(now.getTime() - DISPATCH_LEASE_TIMEOUT_MS);

  const claimResult = await context.db.transaction(async (tx) => {
    // Lock app row so per-App concurrency check and claim are atomic across reconciler replicas
    await tx
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.id, app.id))
      .for('update');

    const running = await tx
      .select({ id: builds.id })
      .from(builds)
      .innerJoin(components, eq(builds.componentId, components.id))
      .where(
        and(
          eq(components.appId, app.id),
          eq(builds.status, 'RUNNING'),
          or(isNull(builds.leasedAt), gte(builds.leasedAt, leaseCutoff)),
        ),
      );

    if (running.length >= CONCURRENT_BUILDS_PER_APP) {
      return { type: 'CONCURRENCY_EXCEEDED' as const, count: running.length };
    }

    const [claimedRow] = await tx
      .update(builds)
      .set({
        status: 'RUNNING',
        runner: adapter.name,
        logFidelity: adapter.logFidelity,
        dispatchId,
        leasedAt: now,
        // Cleared until this run is discovered, because `cancelBuild` hands the
        // column to the route.
        runUrl: null,
        // Names only, at the claim, so a failed build still records what it held.
        buildSecretNames,
        // Cleared so a Build refused again after its lease expires reports the
        // refusal again instead of suppressing it.
        dispatchWaitingOn: null,
        // The backoff ends with the wait it paced.
        dispatchAttempts: 0,
        nextDispatchAt: null,
      })
      .where(
        and(
          eq(builds.id, build.id),
          or(
            eq(builds.status, 'PENDING'),
            eq(builds.dispatchId, dispatchId),
            and(
              eq(builds.status, 'RUNNING'),
              isNotNull(builds.leasedAt),
              lt(builds.leasedAt, leaseCutoff),
            ),
          ),
        ),
      )
      .returning({ id: builds.id, dispatchId: builds.dispatchId });

    if (claimedRow !== undefined) {
      return {
        type: 'CLAIMED' as const,
        dispatchId: claimedRow.dispatchId ?? dispatchId,
      };
    }

    return { type: 'NOT_CLAIMED' as const };
  });

  if (claimResult.type === 'CONCURRENCY_EXCEEDED') {
    // The one `waits` that clears itself when a sibling finishes. Recorded anyway,
    // because a queue and a missing binding look the same from PENDING.
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `${app.name} already has ${claimResult.count} builds running, which is this installation's limit`,
      { kind: 'waits' },
    );
  }

  if (claimResult.type === 'NOT_CLAIMED') {
    const [current] = await context.db
      .select({
        status: builds.status,
        artifactDigest: builds.artifactDigest,
        runner: builds.runner,
        dispatchId: builds.dispatchId,
      })
      .from(builds)
      .where(eq(builds.id, build.id));
    if (current?.status === 'SUCCEEDED') {
      return ok({
        buildId: build.id,
        status: 'SUCCEEDED',
        artifactDigest: current.artifactDigest,
        runner: current.runner ?? 'supplied',
        dispatchId: current.dispatchId ?? dispatchId,
      });
    }
    if (current?.status === 'FAILED') {
      return ok({
        buildId: build.id,
        status: 'FAILED',
        artifactDigest: null,
        runner: current.runner ?? adapter.name,
        dispatchId: current.dispatchId ?? dispatchId,
      });
    }
    // Not recorded: another replica won this row and is writing its log now.
    reconcilerDispatchAttempts.add(1, { outcome: 'lost' });
    return failed(
      'NOT_BUILDABLE',
      `Build ${build.id} is already running on ${current?.runner ?? adapter.name}`,
    );
  }

  const activeDispatchId = claimResult.dispatchId;

  // Every write from here carries the claim. `dispatchId` is a fencing token:
  // matching zero rows means another attempt has replaced this one.
  const mine = and(
    eq(builds.id, build.id),
    eq(builds.dispatchId, activeDispatchId),
  );

  // Minted after every refusal and the claim, so a refused attempt spends no STS
  // exchange or SignBlob, and the bearer URL stays off the row and the log.
  const fetchable = await fetchableBundleLocation(
    context,
    app,
    build.bundleLocation,
  );
  if (!fetchable.ok) {
    // A location no route can fetch is a fact about this row, so the Build is
    // closed out, and `refuseDispatch` settles the claimed row as FAILED.
    if (!isFetchableBundleLocation(build.bundleLocation)) {
      return refuseDispatch(
        context,
        { ...subject, dispatchId: activeDispatchId },
        'NOT_BUILDABLE',
        fetchable.failure.message,
        { kind: 'closes', reason: 'ARTIFACT_UNAVAILABLE' },
      );
    }
    // Federation problems wait for an operator. The claim is released in the same
    // write, fenced on the dispatch id so another replica's claim is left alone.
    const sentence = fetchable.failure.message;
    if (subject.waitingOn !== sentence) {
      await recordBuildEvent(context.db, subject.attempt, {
        type: 'log',
        line: sentence,
        resource: 'dispatch',
      });
    }
    const attempts = subject.attempts + 1;
    await context.db
      .update(builds)
      .set({
        status: 'PENDING',
        runner: null,
        logFidelity: null,
        dispatchId: null,
        leasedAt: null,
        dispatchWaitingOn: sentence,
        dispatchAttempts: attempts,
        nextDispatchAt: new Date(now.getTime() + dispatchBackoffMs(attempts)),
      })
      .where(and(mine, eq(builds.status, 'RUNNING')));
    reconcilerDispatchAttempts.add(1, { outcome: 'waiting' });
    return failed('NOT_BUILDABLE', sentence);
  }

  const buildSource: BuildSource = {
    bundleDigest: build.bundleDigest,
    origin: buildOriginOf({ ...source, location: fetchable.value }),
  };
  reconcilerDispatchAttempts.add(1, { outcome: 'dispatched' });

  // Renewed on a timer, because a quiet far side may send no event for longer
  // than the lease. A renewal that lands after the verdict matches no row.
  const renewal = setInterval(() => {
    void context.db
      .update(builds)
      .set({ leasedAt: context.clock?.now() ?? new Date() })
      .where(and(mine, eq(builds.status, 'RUNNING')))
      .catch(() => {});
  }, DISPATCH_LEASE_REFRESH_MS);

  try {
    // The route names its far side by the claim's id, so `cancelBuild` can reach it.
    const stream = adapter.build(buildSource, spec, activeDispatchId);
    let next = await stream.next();
    while (!next.done) {
      const event = next.value;
      // Written when reported, so the screen can offer it during the run.
      if (event.type === 'runner') {
        await context.db.update(builds).set({ runUrl: event.url }).where(mine);
        next = await stream.next();
        continue;
      }
      // Build and deploy events share one attempt log, so the UI subscribes once.
      await recordBuildEvent(
        context.db,
        attempt,
        event.type === 'log'
          ? {
              type: 'log',
              line: event.line,
              ...(event.step ? { resource: event.step } : {}),
            }
          : { type: 'status', phase: event.state, resource: event.step },
      );
      next = await stream.next();
    }
    const result = next.value;

    if (result.status === 'FAILED') {
      // The row before the log, everywhere below: the fenced write decides whether
      // this attempt has a verdict at all.
      const settled = await context.db
        .update(builds)
        .set({ status: 'FAILED' })
        .where(mine)
        .returning({ id: builds.id });
      if (settled.length === 0) return lostClaim(context, attempt);
      await recordBuildEvent(context.db, attempt, {
        type: 'status',
        phase: 'FAILED',
        reason: result.reason,
      });
      return ok({
        buildId: build.id,
        status: 'FAILED' as const,
        artifactDigest: null,
        runner: adapter.name,
        dispatchId: activeDispatchId,
      });
    }

    const finalized = await context.adapters.supplyChain().finalize({
      artifact: result.artifact,
      provenance: result.provenance,
      backend: adapter.name,
      expectedBuilderId: adapter.provenanceBuilderId,
      maximumLevel: adapter.buildLevel,
      // A shape-only Build has no Target policy yet. Every Deploy checks the
      // Target's threshold again.
      minimumLevel: targetPolicy?.minimumLevel ?? 1,
      source: buildSource,
    });
    if (!finalized.ok) {
      const settled = await context.db
        .update(builds)
        .set({ status: 'FAILED' })
        .where(mine)
        .returning({ id: builds.id });
      if (settled.length === 0) return lostClaim(context, attempt);
      await recordBuildEvent(context.db, attempt, {
        type: 'log',
        line: `supply-chain admission failed: ${finalized.message}`,
        resource: 'provenance',
      });
      await recordBuildEvent(context.db, attempt, {
        type: 'status',
        phase: 'FAILED',
        reason: 'BUILD_FAILED',
      });
      return ok({
        buildId: build.id,
        status: 'FAILED' as const,
        artifactDigest: null,
        runner: adapter.name,
        dispatchId: activeDispatchId,
      });
    }

    const settled = await context.db
      .update(builds)
      .set({
        status: 'SUCCEEDED',
        artifactDigest: result.artifact.digest,
        artifactRefs: [...result.artifact.refs],
        baseDigest: result.baseDigest,
        provenance: finalized.assessment,
        verifiedBuildLevel: finalized.assessment.achievedLevel,
        signature: finalized.signature,
        buildkitProvenanceRef: result.buildkitProvenanceRef,
        sbomRef: result.sbomRef,
      })
      .where(mine)
      .returning({ id: builds.id });
    if (settled.length === 0) return lostClaim(context, attempt);

    await recordBuildEvent(context.db, attempt, {
      type: 'status',
      phase: 'SUCCEEDED',
    });

    return ok({
      buildId: build.id,
      status: 'SUCCEEDED' as const,
      artifactDigest: result.artifact.digest,
      runner: adapter.name,
      dispatchId: activeDispatchId,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const settled = await context.db
      .update(builds)
      .set({ status: 'FAILED' })
      .where(mine)
      .returning({ id: builds.id });
    if (settled.length === 0) return lostClaim(context, attempt);
    await recordBuildEvent(context.db, attempt, {
      type: 'log',
      line: `build dispatch failed: ${detail}`,
    });
    await recordBuildEvent(context.db, attempt, {
      type: 'status',
      phase: 'FAILED',
      reason: 'INTERNAL',
    });
    return ok({
      buildId: build.id,
      status: 'FAILED' as const,
      artifactDigest: null,
      runner: adapter.name,
      dispatchId: activeDispatchId,
    });
  } finally {
    clearInterval(renewal);
  }
};
