/**
 * The build adapter contract (§4).
 *
 * ```
 * build(source, spec) -> { artifact { type, digest, refs[] },
 *                          status, logs, provenance, baseDigest }
 * ```
 *
 * **Build is always separate from Deploy.** A platform's own build-from-source
 * path is never used, because fusing the two would force a rollback to rebuild
 * (§4). What comes back is a recorded artifact, not a deployed one — which is
 * also why there is no ordinal and no `SUPERSEDED`: builds run concurrently up
 * to a per-App limit, and a late-finishing older build moves nothing (§4).
 *
 * The two supply-chain terms this contract carries (§16):
 *
 * - **The bundle digest is a parameter on every route.** Without it the source
 *   receipt and the provenance document have no join, and correlation joins on
 *   digest. It is a required field of {@link BuildSource} and it comes back on
 *   {@link BuildProvenance}, so no route can quietly not take one.
 * - **The adapter never signs.** It returns artifact and digest exactly as
 *   specified and core signs that digest, so no backend is disqualifiable and
 *   the claim made is the honest one.
 */
import type { RegistryFlavour } from '../../domain/artifact-name.ts';
import type {
  Artifact,
  ArtifactType,
  ComponentKind,
  Platform,
} from '../../domain/desired-state.ts';
import type { RegistryAuth } from '../../storage/registry-credentials.ts';
import type { FailureReason } from '../deploy/contract.ts';

/**
 * Where the source came from. Repo and archive share **one pipeline** — unpack,
 * detect, build — so this is an origin, not a second contract (§4, §5).
 */
export type BuildOrigin =
  | {
      type: 'repo';
      /** The repository fetched. */
      repository: string;
      /** The exact commit. Triggers fire on default-branch HEAD (§5). */
      commit: string;
      /** An App is repo plus subpath; the scope is named, never searched (§5). */
      subpath: string;
      /**
       * Where the builder fetches the staged bundle for that commit from.
       *
       * Present on **both** arms, because §15 stages one immutable bundle "for
       * either builder" and a route that cloned the commit again would build a
       * second tree — one the source receipt's digest does not describe. The
       * repository and commit stay beside it because a backend that can bind
       * them natively produces stronger provenance for having them (§16); they
       * are not what gets fetched.
       */
      location: string;
    }
  | {
      type: 'archive';
      /** Where the builder fetches the staged upload from. */
      location: string;
      /** Applied after unwrapping a lone top-level directory (§5). */
      subpath: string;
    };

/**
 * What to build.
 *
 * `bundleDigest` sits at the top rather than inside {@link BuildOrigin} because
 * §16 states it as a parameter of every *route*, not a property of one kind of
 * source: a git fetch and a ZIP upload are one predicate with different
 * principals, and both are digested over the bundle that was staged.
 */
export interface BuildSource {
  /**
   * Digest over the staged bundle. Required — it is the join between the source
   * receipt Spindrift signs and the provenance document the backend produces
   * (§16).
   */
  bundleDigest: string;
  origin: BuildOrigin;
}

/**
 * What shape to build it in.
 *
 * Resolution runs **before** the build and outputs placement plus artifact
 * shape, which is why the build key includes the target shape and why changing
 * placement across shapes forces a rebuild (§3).
 *
 * The frontend is not here: BuildKit takes the repo's Dockerfile if present and
 * a zero-config builder otherwise, and that ladder runs inside the pipeline,
 * because a Dockerfile settles how to build and never what the thing is (§4,
 * §5).
 */
export interface BuildSpec {
  /** The shape placement chose, not one the kind implies (§3, §6). */
  artifactType: ArtifactType;
  /** What was detected, carried so the zero-config builder can plan (§5). */
  kind: ComponentKind;
  /** What the artifact must run on (§3). */
  platform: Platform;
  /**
   * The **repositories** the artifact is published to, without tags. Core
   * composes them from the installation's registries (§16); an adapter never
   * chooses its own destination.
   *
   * Repositories and not the installation's registry namespaces: a namespace
   * is a prefix, and a registry answers `NAME_INVALID` to a single-segment
   * path. `componentRepositories` composes them.
   *
   * **Several, and every one is pushed to.** Two Targets on one installation
   * cannot always share a registry — the cluster pulls anonymously from GitHub
   * Container Registry, while Cloud Run pulls through a cache mirror that
   * could not parse the OCI index pushed there. One build, one digest, N
   * destinations: the runner pushes the same manifest to each and reports a
   * reference per registry, and each Target pins the one it can reach.
   *
   * Order is the manifest's, and it is the order `refs` comes back in — so the
   * first stays what a Target with no declared `reachableRegistries` gets.
   *
   * Never empty: a build with nowhere to push is refused at dispatch.
   */
  destinations: readonly string[];
  /**
   * The tags to push it under, most specific first (§12).
   *
   * Separate from {@link destination} rather than folded into it because the
   * two are read by different things: the destination alone is what an
   * immutable `repository@digest` reference is built from — which is what the
   * build report carries and what a Deploy pins — while the tags exist for
   * §12's retention to count and for a person to type. A destination that
   * already carried a tag would put one in every digest reference derived from
   * it.
   *
   * Never empty: a build that pushed under no tag would be collected by the
   * first retention pass that ran.
   */
  tags: readonly string[];
  /**
   * Build arguments as ordinary rows, never fetched from a store: whatever a
   * website bakes becomes public anyway, so no builder ever holds a store
   * credential (§4, §10).
   */
  buildArgs: Readonly<Record<string, string>>;
  /**
   * Where a `files` build lifts the site out of, or `null` to ship the scope
   * as it stands (§3, story 42).
   *
   * `domain/detection/declared.ts` calls this "where *Spindrift* lifts files
   * from when a website is placed on a static Target", and this is the field
   * that carries the answer to the one place that can act on it. Without it a
   * `files` build has no way to know that `dist/` is the site and the rest of
   * the tree is the sources that produced it, so it ships both — which is what
   * a static Target then serves.
   *
   * **Per commit, not per Component**, which is why it is composed here rather
   * than read from a column. The value's home of record is the scope's
   * `spindrift.yaml` (§5: "once it is on the default branch it wins over
   * detection"), a file that moves with the tree — so a Component whose site
   * moved from `build/` to `dist/` is described correctly by each commit and
   * incorrectly by any single stored answer.
   *
   * `null` is not "unknown": it is the honest state for a scope that declares
   * no output directory and for one built from its own Dockerfile, and both
   * mean the tree already is the artifact. An `image` build ignores this.
   */
  outputDirectory: string | null;
  /**
   * Which framework a `vercel-output` build tells the platform's own builder it
   * is building, or `null` for every other shape.
   *
   * **Not a hint, and not defaultable.** `vercel build` performs no detection
   * of its own: a build whose settings name no framework is built as "Other",
   * which copies the tree into `static/` and emits no functions — a green build
   * that serves an SSR app's own sources. So a `vercel-output` build with a
   * `null` framework is refused before dispatch rather than run.
   *
   * Core's answer rather than the runner's, for §3's reason: the artifact's
   * shape is resolution output, and a runner that decided this could produce a
   * different shape than the one the Build was keyed on.
   */
  vercelFramework: string | null;
  /**
   * Registry logins for the destinations whose host the route's own identity
   * cannot authorize (§16).
   *
   * **Empty is the ordinary case and the preferred one.** §13 wants every push
   * authorized by the route that makes it — a projected service account token
   * in-cluster, a federated token for the cloud builder, the run's own token
   * for hosted CI — and where that works nothing is stored and nothing is
   * handed over. This carries the exception: Docker Hub trusts no federated
   * identity, so an installation pushing there either hands a token to the
   * builder or does not push there.
   *
   * One entry per *host*, because that is what a registry login authenticates
   * and what the Docker config a builder reads is keyed on.
   *
   * A route that cannot carry one declares so with
   * {@link BuildAdapter.carriesHeldSecret}, and `dispatchBuild` refuses
   * before dispatching rather than sending the field to a route that would put
   * it somewhere readable.
   */
  registryAuth: readonly RegistryAuth[];
  /**
   * The Component's declared build secrets, resolved (story 112).
   *
   * Each reaches the engine as a BuildKit secret mount — available to a `RUN`
   * that asks for it by name, absent from every layer, from the build log, and
   * from the baked artifact. Not {@link buildArgs} with ceremony: a build
   * argument is defined by being baked and a secret mount is defined by not
   * being, which is why the §4 rule against fetching arguments from a store
   * does not reach here.
   *
   * Values, not references. Core resolved them against §10's store at
   * dispatch, so the builder holds the secret for the length of one build and
   * never a credential *to the store* — the half of §4's sentence that
   * survives. A route that cannot carry one is refused at dispatch via
   * {@link BuildAdapter.carriesHeldSecret}, the same gate `registryAuth`
   * passes through.
   *
   * Provenance records the *names* alone: they are what someone reproducing
   * the build needs, and the store reference beside them would be a map of
   * where this installation keeps its credentials, published with the
   * artifact.
   */
  buildSecrets: readonly BuildSecretValue[];
}

/** One resolved build secret, alive for the length of one dispatch. */
export interface BuildSecretValue {
  /** The mount id a `RUN --mount=type=secret,id=<name>` asks for. */
  readonly name: string;
  /** Plaintext, resolved by core at dispatch. Never persisted in this form. */
  readonly value: string;
}

/**
 * How faithfully a route's logs can be read while the build runs (§4).
 *
 * Logs are **read, not pushed**. Reading is outbound only, needs no public
 * ingest endpoint, and surfaces the failures that happen *before* the
 * instrumented step would have reported anything.
 *
 * - `LIVE_TEXT` — log events arrive as the backend emits them.
 * - `LIVE_STATUS` — only step events arrive live; text lands at the end.
 * - `ON_COMPLETION` — nothing arrives until the build is over.
 */
export const LOG_FIDELITIES = [
  'LIVE_TEXT',
  'LIVE_STATUS',
  'ON_COMPLETION',
] as const;

export type LogFidelity = (typeof LOG_FIDELITIES)[number];

/**
 * What a build step, and therefore a Build row, can be. `PENDING` is core's
 * alone — a Build exists before a route has been handed it — so it is not part
 * of the adapter-facing `BuildEvent` state.
 */
export const BUILD_STATES = ['RUNNING', 'SUCCEEDED', 'FAILED'] as const;

export type BuildState = (typeof BUILD_STATES)[number];

/**
 * What a route yields while it runs, at whatever fidelity it declared.
 *
 * `runner` is not a log line, and the distinction is the point. A route that
 * can be watched somewhere else says so **once, as a fact about the run**, and
 * core records it on the Build rather than appending it to the stream. Putting
 * it in the log would file it under exactly the thing it compensates for: at
 * `LIVE_STATUS` the log is empty until the run ends, so a link inside it would
 * arrive too late to be worth following. Emitted as soon as the backend knows
 * where the run is, which is what makes it useful while the run is going.
 */
export type BuildEvent =
  | { type: 'log'; at: Date; line: string; step?: string }
  | { type: 'step'; at: Date; step: string; state: BuildState }
  | { type: 'runner'; at: Date; url: string };

/**
 * SLSA Build Level. A Target has a minimum defaulting to L2 and an ordered list
 * of build routes: **the level is a threshold, then admin rank wins** (§16).
 * The in-cluster route is L1, which is why a Target cannot be both
 * offline-capable and require L2 or above (§4).
 */
export type BuildLevel = 1 | 2 | 3;

/**
 * The backend's provenance — the isolation claim core verifies against the
 * Target's minimum level **before** signing, which closes the custody-only gap
 * while preserving one signature and one deploy-time check (§16).
 *
 * The builder's *own* provenance is a second, unsigned document carrying
 * materials; it is where {@link BuildResult.baseDigest} comes from, so it adds
 * no term here (§16).
 */
export interface BuildProvenance {
  /**
   * The bundle digest this build was given, echoed. Required: a route that
   * cannot report the digest it was handed cannot produce a joinable
   * provenance, and no-provenance modes are ineligible (§16).
   */
  bundleDigest: string;
  /** The level this run claims. Core verifies it; it is not taken on trust. */
  claimedLevel: BuildLevel;
  /** The document itself, opaque to the adapter and read by core (§16). */
  statement: unknown;
}

/**
 * The route that ran and how well it could be watched. §4: **the build backend
 * and its fidelity are visible on the Build**, because fidelity varies by runner
 * and an invisible runner makes that look like a bug.
 */
export interface BuildLogs {
  /** The route's own name, as the installation configured it. */
  backend: string;
  fidelity: LogFidelity;
}

/**
 * §4's return record. Both arms carry all five names; the discriminant is
 * `status`, so a green build is the only shape that can carry an artifact and a
 * provenance, and a red one cannot pretend to.
 *
 * The failure `reason` is drawn from the **shared** vocabulary (§6): the user
 * sees one timeline and must not meet two vocabularies along it.
 */
export type BuildResult =
  | {
      status: 'SUCCEEDED';
      artifact: Artifact;
      logs: BuildLogs;
      provenance: BuildProvenance;
      /**
       * The base image this artifact was built on, from the builder's own
       * materials. `null` where there is no base — a files artifact has none.
       * Stale bases are **surfaced, never auto-corrected**: a base is fresh only
       * at build time, and a repo's Dockerfile stays sovereign (§16).
       */
      baseDigest: string | null;
      /** Raw BuildKit materials evidence, attached to the artifact. */
      buildkitProvenanceRef: string | null;
      /** SPDX evidence, deliberately not assessed in v1. */
      sbomRef: string | null;
    }
  | {
      status: 'FAILED';
      artifact: null;
      logs: BuildLogs;
      provenance: null;
      baseDigest: null;
      buildkitProvenanceRef: null;
      sbomRef: null;
      reason: FailureReason;
      detail?: string;
      debug?: unknown;
    };

/**
 * One build route.
 *
 * §4 names three: hosted CI on the fast-pipe side, a cloud build service, and
 * the in-cluster one. The route's name is a string rather than a union because
 * which routes exist is an installation's configuration, not this contract's
 * vocabulary (§20).
 *
 * `build` is written as a generator for the same reason `apply` is: the yielded
 * values are the timeline at whatever fidelity the route declared, and the
 * return value is §4's record.
 */
export interface BuildAdapter {
  readonly name: string;
  /** Declared, not measured: it is a property of the runner (§4). */
  readonly logFidelity: LogFidelity;
  /**
   * The level this route's profile guarantees. Guarantees belong to code-defined
   * backend profiles; the achieved level belongs to the concrete verified Build
   * (§16).
   */
  readonly buildLevel: BuildLevel;
  /**
   * The trusted builder identity this code-defined profile expects provenance
   * verification to authenticate. Evidence never gets to choose its verifier.
   */
  readonly provenanceBuilderId: string;
  /**
   * Whether this route can be handed a secret this installation holds —
   * {@link BuildSpec.registryAuth} and {@link BuildSpec.buildSecrets} alike —
   * without putting it somewhere it should not be.
   *
   * A property of the route's *mechanism*, not a policy, which is why it is
   * one capability and not one per kind of secret: what makes a route safe to
   * hand a registry login is exactly what makes it safe to hand a build
   * secret, and two flags could only ever disagree by mistake. The routes
   * that run the BuildKit program in a container of their own take a secret
   * through an environment variable scoped to that container. The hosted
   * route is dispatched by a `workflow_dispatch` whose inputs GitHub renders
   * in the run header, so a value in the request would be published to anyone
   * who can see the run — including a repository the installation does not
   * own — and it answers `true` only where it has somewhere else to put one:
   * see `GitHubActionsBuildRoute.carriesHeldSecret` for the sealed mechanism
   * that opens up.
   *
   * A route with nowhere configured to carry one answers `false`, and
   * `dispatchBuild` refuses a build that needs a held secret on it — which is
   * the direction being wrong has to fail in.
   */
  readonly carriesHeldSecret: boolean;
  /**
   * The registry flavours this route's own identity can push to unaided.
   *
   * §13's "nothing stored" is the rule, and this is what the rule actually
   * buys per route — which is not the same set for all three. A route pushes
   * to the registries in here without a credential existing anywhere; for
   * anything else the installation either holds a login (§16's exception) or
   * that registry is not a destination this route can publish to.
   *
   * Declared rather than probed, for the same reason `buildLevel` is: core has
   * to know where a route can publish *before* dispatching it, and finding out
   * by trying costs a whole build to learn.
   *
   * Flavours and not hosts, because that is what the identity is scoped to: a
   * federated token authenticates one vendor's registries, every regional
   * endpoint of them, and a route that listed hosts would be a route that
   * broke when someone added a region.
   */
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[];

  build(
    source: BuildSource,
    spec: BuildSpec,
  ): AsyncGenerator<BuildEvent, BuildResult, void>;
}
