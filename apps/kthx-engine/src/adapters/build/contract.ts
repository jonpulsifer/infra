/**
 * The build adapter contract. A build records an artifact and deploys nothing,
 * so a rollback needs no rebuild. Core signs the digest a route reports.
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

/** Where the source came from. Repo and archive builds share one pipeline. */
export type BuildOrigin =
  | {
      type: 'repo';
      repository: string;
      commit: string;
      /** The App's scope in the repository, named and never searched for. */
      subpath: string;
      /**
       * The staged bundle for that commit. Builders fetch this and never clone,
       * so the tree they build is the one the source receipt's digest describes.
       */
      location: string;
    }
  | {
      type: 'archive';
      /** Where the builder fetches the staged upload from. */
      location: string;
      /** Applied after unwrapping a lone top-level directory. */
      subpath: string;
    };

export interface BuildSource {
  /**
   * Digest of the staged bundle. It joins the source receipt core signs to the
   * backend's provenance.
   */
  bundleDigest: string;
  origin: BuildOrigin;
}

/**
 * What shape to build, resolved before dispatch. Whether to use the repo's
 * Dockerfile or the zero-config frontend is decided inside the build program.
 */
export interface BuildSpec {
  /** Chosen by placement. */
  artifactType: ArtifactType;
  kind: ComponentKind;
  platform: Platform;
  /**
   * Repositories without tags, one per registry, each pushed the same manifest.
   * Never empty, and `refs` comes back in this order.
   */
  destinations: readonly string[];
  /**
   * Tags to push under, most specific first. Never empty, or the first retention
   * pass would collect the image.
   */
  tags: readonly string[];
  /**
   * Plain values, never read from a secret store: build arguments end up in
   * the artifact.
   */
  buildArgs: Readonly<Record<string, string>>;
  /**
   * Where a `files` build lifts the site from, or `null` to ship the scope as it
   * stands. Read per commit from the scope's config. An `image` build ignores it.
   */
  outputDirectory: string | null;
  /**
   * The framework a `vercel-output` build names, else `null`. Dispatch requires
   * one there: `vercel build` does no detection and builds as static files.
   */
  vercelFramework: string | null;
  /**
   * Stored logins, one per registry host, for destinations the route's own
   * identity cannot push to. Usually empty; Docker Hub needs one.
   */
  registryAuth: readonly RegistryAuth[];
  /**
   * The Component's build secrets, resolved at dispatch and passed as BuildKit
   * secret mounts, so no layer, log or artifact holds them.
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
 * How much of a build's log can be read while it runs. `LIVE_TEXT`: lines as
 * emitted. `LIVE_STATUS`: step events live, text at the end. `ON_COMPLETION`:
 * nothing until the build ends.
 */
export const LOG_FIDELITIES = [
  'LIVE_TEXT',
  'LIVE_STATUS',
  'ON_COMPLETION',
] as const;

export type LogFidelity = (typeof LOG_FIDELITIES)[number];

/** The states a route reports. A Build's `PENDING` is core's alone, before dispatch. */
export const BUILD_STATES = ['RUNNING', 'SUCCEEDED', 'FAILED'] as const;

export type BuildState = (typeof BUILD_STATES)[number];

/**
 * What a route yields while it runs. `runner` is where the run can be watched
 * live, and core stores it on the Build as soon as it arrives.
 */
export type BuildEvent =
  | { type: 'log'; at: Date; line: string; step?: string }
  | { type: 'step'; at: Date; step: string; state: BuildState }
  | { type: 'runner'; at: Date; url: string };

/** SLSA Build Level. A Target requires a minimum, L2 by default. */
export type BuildLevel = 1 | 2 | 3;

/** The backend's provenance, which core verifies before signing. */
export interface BuildProvenance {
  /** Echoed from the source; it joins the provenance to the source receipt. */
  bundleDigest: string;
  /** Core caps it at the route's `buildLevel`. */
  claimedLevel: BuildLevel;
  /** Opaque to the adapter; core verifies it. */
  statement: unknown;
}

/** Shown on the Build, so a sparse log reads as the runner's limit. */
export interface BuildLogs {
  /** The route's own name, as the installation configured it. */
  backend: string;
  fidelity: LogFidelity;
}

export type BuildResult =
  | {
      status: 'SUCCEEDED';
      artifact: Artifact;
      logs: BuildLogs;
      provenance: BuildProvenance;
      /**
       * The base image, from the builder's materials, or `null` where there is
       * none. A stale base is reported, never rebuilt automatically.
       */
      baseDigest: string | null;
      /** Raw BuildKit materials evidence, attached to the artifact. */
      buildkitProvenanceRef: string | null;
      /** SPDX evidence, recorded and not assessed. */
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
 * What the Build row stores about a running attempt. `cancel` runs in another
 * process than `build`, so it reaches the far side only through these.
 */
export interface BuildHandle {
  /** The id core minted for the attempt and passed to `build`. */
  readonly dispatchId: string;
  /** The URL the route yielded as a `runner` event, or `null` if it never did. */
  readonly runUrl: string | null;
}

export interface BuildAdapter {
  readonly name: string;
  /** Declared by the route, never measured. */
  readonly logFidelity: LogFidelity;
  /** The most this route can achieve; a Build's claimed level is capped at it. */
  readonly buildLevel: BuildLevel;
  /** The builder identity provenance verification requires; evidence cannot choose it. */
  readonly provenanceBuilderId: string;
  /**
   * Whether `registryAuth` and `buildSecrets` can be handed to this route
   * safely. Dispatch refuses a build that needs one where this is `false`.
   */
  readonly carriesHeldSecret: boolean;
  /**
   * Registry flavours this route's own identity can push to with no stored
   * credential. Declared, so core knows before dispatch where a route can publish.
   */
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[];

  /**
   * `dispatchId` names the far side so `cancel` can find it from the Build row.
   * Without one, the route mints its own id and nothing stored can reach the run.
   */
  build(
    source: BuildSource,
    spec: BuildSpec,
    dispatchId?: string,
  ): AsyncGenerator<BuildEvent, BuildResult, void>;

  /**
   * Stop the far side if it is still running; the build's own poll then reports
   * `FAILED`. A finished or missing far side is not an error. Throws when the
   * route cannot address the far side at all.
   */
  cancel(handle: BuildHandle): Promise<void>;
}
