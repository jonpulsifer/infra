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
import type {
  Artifact,
  ArtifactType,
  ComponentKind,
  Platform,
} from '../../domain/desired-state.ts';
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
   * Where the artifact is published. Core picks it from the Target's
   * `reachableRegistries` (§3); an adapter never chooses its own destination.
   */
  destination: string;
  /**
   * Build arguments as ordinary rows, never fetched from a store: whatever a
   * website bakes becomes public anyway, so no builder ever holds a store
   * credential (§4, §10).
   */
  buildArgs: Readonly<Record<string, string>>;
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

/** What a route yields while it runs, at whatever fidelity it declared. */
export type BuildEvent =
  | { type: 'log'; at: Date; line: string; step?: string }
  | { type: 'step'; at: Date; step: string; state: BuildState };

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
    }
  | {
      status: 'FAILED';
      artifact: null;
      logs: BuildLogs;
      provenance: null;
      baseDigest: null;
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

  build(
    source: BuildSource,
    spec: BuildSpec,
  ): AsyncGenerator<BuildEvent, BuildResult, void>;
}
