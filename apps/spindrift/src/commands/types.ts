/**
 * The application command layer (§21 Boundaries).
 *
 * §21: "v1 exposes neither a supported external API nor a CLI... The boundary
 * is nevertheless explicit inside the application. Creation, building,
 * deployment, rollback, and desired-state changes are application commands,
 * not logic embedded in pages, so a later thin API or CLI can wrap them
 * without reconstructing the domain from UI handlers. This is the primary
 * test seam."
 *
 * Hence the shape here: **one exported function per user act**, in its own
 * module beside its input schema, taking an explicit input object and a
 * request context and returning a typed result. Nothing in this layer knows it
 * is reached over HTTP, from a page, or from a test — `registry.ts` is the only
 * thing that knows a command can be named, and a route above it may hold no
 * domain logic whatsoever.
 *
 * The context is the whole of what a command may reach for. Anything absent
 * from it — the wall clock, a connection string, an ambient adapter — is a
 * dependency a test cannot replace, and the seam is only primary if every one
 * of them can be replaced.
 */
import type { BuildAdapter } from '../adapters/build/contract.ts';
import type { GcpDiscovery } from '../adapters/cloud-discovery.ts';
import type { CloudflareAccounts } from '../adapters/cloudflare.ts';
import type { DatastoreAdapter } from '../adapters/datastore/contract.ts';
import type { DeployAdapter } from '../adapters/deploy/contract.ts';
import type { SecretStore } from '../adapters/store/contract.ts';
import type {
  AuthoredManifest,
  InstallationManifest,
  StoreAdapter,
  TargetAdapter,
} from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import type {
  RepositoryAuthorization,
  RepositoryHost,
} from '../domain/repository.ts';
import type { RepositorySourceStager } from '../domain/source-bundle.ts';
import type { FunctionDeployers } from '../functions/contract.ts';
import type { FunctionEnvSealer } from '../functions/env.ts';
import type { RegistryTransport } from '../storage/registry.ts';
import type { RegistryCredentialStore } from '../storage/registry-credentials.ts';
import type { SupplyChain } from '../supply-chain/sign.ts';

/**
 * Who is acting.
 *
 * §"First run and identity": every enrolled user is one fully privileged
 * kind, so there is no role here to branch on — a command knows *who*, and v1
 * never asks *whether*.
 */
export interface Principal {
  /** The `users` row this act is attributed to. */
  readonly id: string;
  readonly displayName: string;
}

/**
 * Time, injected.
 *
 * A handler calling `Date.now()` is a handler whose result cannot be asserted,
 * and every row this layer writes carries a timestamp. The clock is therefore
 * part of the context rather than a global.
 */
export interface Clock {
  now(): Date;
}

/** The clock every non-test caller passes. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * The adapters a command may reach the outside world through (§6, §20).
 *
 * Lookups return `null` rather than throwing: an installation that has no
 * adapter for a Target's declared type is a configuration fact a command must
 * report, not an exception it should propagate. Tests substitute fakes here —
 * "fake the far side, not our side" (§ Testing) — and this is the only
 * far side there is.
 */
export interface AdapterRegistry {
  /** The delivery adapter for a Target's one adapter type (§13). */
  deploy(adapter: TargetAdapter): DeployAdapter | null;
  /**
   * A build route by name. §4: which routes exist is an installation's
   * configuration, not a closed vocabulary.
   */
  build(route: string): BuildAdapter | null;
  /**
   * §10: the store of record a Target's config is written through.
   *
   * By adapter rather than one store per installation, because §10 makes the
   * store a **Target** property — "Kubernetes Targets carry an admin-chosen
   * store; the cloud Targets take the cloud store in the App's vessel, not a
   * choice" — and because a re-placement between two stores is a thing core has
   * to be able to describe even while an installation has configured one.
   * `null` is the ordinary answer for a store this installation has no access
   * path to, and a Target that reaches only those cannot hold config.
   */
  store(adapter: StoreAdapter): SecretStore | null;
  /**
   * §11's datastore lifecycle, for a Target's one adapter type (§13).
   *
   * Keyed the same way `deploy` is, because a Datastore lives on a Target —
   * "delivery follows the Datastore's placement" — and a second key would only
   * be able to disagree with the first.
   *
   * Optional on the registry rather than required, following `source` and
   * `registryTransport`: a command that finds it absent reports that a Datastore
   * cannot be provisioned here, which is the same kind of configuration fact
   * every other `null` on this interface carries.
   */
  datastore?(adapter: TargetAdapter): DatastoreAdapter | null;
  /**
   * §15's repository host. `null` when this installation has no repository
   * integration configured — which is a legitimate installation, not a fault:
   * §2's other source is an uploaded archive, and it needs no repository at all.
   *
   * Not one of §6's three adapter contracts, and it is here anyway, because
   * this interface is "the adapters a command may reach the outside world
   * through" and a repository is unambiguously one of those. Keeping it out
   * would only mean threading a second far side through the command layer
   * beside the context, which is the shape the context exists to prevent.
   */
  repository(): RepositoryHost | null;
  /** Immutable repository staging, absent until a source depot is configured. */
  source?(): RepositorySourceStager | null;
  /**
   * How an artifact registry's distribution API is reached (§16).
   *
   * A transport rather than a client, because that is honestly all it is: the
   * probe is one unauthenticated `GET /v2/` and there is no credential, no
   * session, and no second call for a client to hold. Anything richer would be
   * an interface with one implementation standing in front of `fetch`.
   *
   * Optional for the same reason `source` is: a test's registry omits it, and a
   * command that finds it absent reports that rather than reaching for a global.
   */
  registryTransport?(): RegistryTransport | null;
  /**
   * The registry push credentials this installation holds (§16).
   *
   * `null` when there is no keyring to seal them with, which is the same
   * condition the GitHub connector reports for the same reason: without an
   * installation Secret to open ciphertext there is nowhere durable to keep a
   * token, and a command says so rather than storing one in the clear.
   */
  registryCredentials?(): RegistryCredentialStore | null;
  /**
   * The user-mediated connector, where this repository integration has one.
   *
   * Optional on the registry itself so existing non-interactive adapters and
   * test fakes remain honest: repository operations do not imply an OAuth
   * ceremony.
   */
  repositoryAuthorization?(): RepositoryAuthorization | null;
  /**
   * Reading the cloud this installation already runs in (§13, §20).
   *
   * Answers what an operator would otherwise type into the manifest by hand —
   * projects, buckets, signing keys — over the same federated provider the
   * cloud deploy adapters and the cloud build route are given, so the token
   * exchange is made once per process rather than once per question.
   *
   * Optional for the reason the four lookups above it are: a registry that
   * cannot reach a cloud API is an ordinary installation, and every hand-built
   * test registry that has no opinion about discovery stays honest by omitting
   * it. A command that finds it absent says so rather than reaching for a
   * global.
   */
  discovery?(): GcpDiscovery | null;
  /**
   * Reading a connected Cloudflare account (§13, §20).
   *
   * The boundary's own inventory — its zones, its Workers subdomain, its Pages
   * projects — as distinct from `deploy('cloudflare-pages')`, which answers for
   * one surface on it. Optional for the reason `discovery` above is: a registry
   * with no Cloudflare bearer is an ordinary installation, and a caller that
   * finds it absent records that nothing was read rather than reaching for a
   * global.
   */
  cloudflare?(): CloudflareAccounts | null;
  /**
   * The Functions surfaces this installation can deploy to, keyed by target.
   *
   * Optional for the reason every far side above it is: a test registry with
   * no opinion about Functions omits it, and `saveFunction`/`deleteFunction`
   * read a missing entry the same way they read a `null` deployer — as
   * `NOT_DEPLOYABLE`/`NOT_REMOVABLE`, a configuration fact rather than a fault.
   */
  functions?(): FunctionDeployers | null;
  /**
   * How a Function's environment is sealed and opened (`functions/env.ts`).
   *
   * `null` when there is no keyring, which is the same condition
   * `registryCredentials` reports for the same reason: without an installation
   * Secret there is nowhere durable to keep a value, and `saveFunction` says so
   * rather than storing one in the clear.
   */
  functionEnv?(): FunctionEnvSealer | null;
  /**
   * Core's verifier and signer (§16).
   *
   * Kept behind the same far-side registry as builders and stores: both tools
   * cross a process or KMS boundary and must be replaceable at the command seam.
   */
  supplyChain(): SupplyChain;
}

/**
 * Everything a command is allowed to reach: who, when, the database, and the
 * far side. A command takes exactly this and its own input — never a module
 * singleton, never `Bun.env`.
 */
export interface CommandContext {
  readonly principal: Principal;
  readonly clock: Clock;
  readonly db: Database;
  readonly adapters: AdapterRegistry;
  /**
   * §20: "everything naming this installation is a value in the installation
   * manifest." A command that needs one of those values takes it from here, so
   * the alternative — a module-level singleton read at import time — never has
   * to exist, and a test can run two installations in one process.
   */
  readonly manifest: InstallationManifest;
  /**
   * The mounted declaration, whole — or `null` where none is mounted, one is
   * unreadable, or a caller has not computed one. `undefined` for the same
   * reason `declarationDivergence` below is: every production context reads
   * this once at boot (`src/web/serve.ts`'s `declaration`) and carries it
   * along, and a test context that does not care is not required to.
   *
   * Answering a whole document here, rather than only the paths it disagrees
   * with, rests on the same guarantee `getInstallationManifest` already leans
   * on to answer `manifest` itself: §13 keeps every manifest variant
   * credential-free by construction, so nothing this field can hold is
   * secret. It does not weaken {@link diffManifestPaths}'s paths-only promise
   * below — that walk stays generic over whatever the schema is next asked to
   * carry regardless of what else the context exposes. Two documents resting
   * on one guarantee, not two guarantees.
   *
   * `configureInstallation` takes exactly this type, which is what makes this
   * field the whole of what a surface needs to put the declaration onto the
   * stored row — see `src/commands/installation/get.ts`.
   */
  readonly declaration?: AuthoredManifest | null;
  /**
   * Dotted paths where {@link declaration} disagrees with `manifest`, from
   * {@link diffManifestPaths}. `undefined` where a caller has not computed
   * one — every production context does; a test context that does not care is
   * not required to.
   *
   * §6: "drift is detected and surfaced, never silently corrected" applies to
   * the manifest itself, not only to what it deploys. `loadStoredManifest`
   * already says this once, in a pod log nobody is watching at the moment a
   * rollout quietly stops matching what is running; this is the same fact
   * reachable from a screen an operator actually opens. `getInstallationManifest`
   * is the one command that answers it — carried on the context, not
   * recomputed by that command, because it has no server-only import to
   * recompute it with (`src/commands/installation/get.ts` says why).
   *
   * **Paths only, exactly as {@link diffManifestPaths} promises — never a
   * value.** A command that reads this must not append a value onto a path
   * before handing it back; doing so would defeat the one property this
   * field exists to keep. Named `declarationDivergence` rather than
   * `manifestDivergence` because `targets/list.ts` answers a different
   * question under a name that used to collide with this one — a Target's
   * row against its own manifest entry, not the declaration against the
   * stored manifest. Same walk, same word `diffManifestPaths` produces,
   * different pair of documents.
   */
  readonly declarationDivergence?: readonly string[];
}

/**
 * Why a command did not do what was asked.
 *
 * Closed on purpose, in the spirit of §6's failure reasons: "a failure test
 * asserts the sentence the user reads", which requires the failure to have an
 * identity a test can key on. Only the two codes the layer can actually
 * produce today are listed — a command that grows a domain failure adds its
 * code here alongside it, rather than the set being guessed at in advance.
 */
export type CommandFailureCode =
  | 'UNKNOWN_COMMAND'
  | 'INVALID_INPUT'
  /** A named thing the input refers to does not exist. */
  | 'NOT_FOUND'
  /**
   * Everything named exists, but this artifact cannot go on this Target — a
   * Build that has not succeeded, a shape the Target does not take (§3), a
   * disconnected Target (§13), a rollback that is not backwards (§6).
   *
   * Distinct from `INVALID_INPUT` because the input was well formed and the
   * caller is not being told to fix a field: they are being told a fact about
   * the world, which is the disabled-with-reasons grammar §3 uses everywhere.
   */
  | 'NOT_DEPLOYABLE'
  /**
   * A Build exists but no route can be handed it — §16's bundle digest is
   * missing, so a provenance document would have nothing to join against.
   */
  | 'NOT_BUILDABLE'
  /**
   * A run was asked for and did not start (§17).
   *
   * One code for every reason, because from the screen they are one fact: the
   * Component is not a job, nothing has been placed on that Target yet, the
   * Target is disconnected, the backend has nothing to run, or the far side
   * refused. The sentence differs; what the operator does next — read it and
   * fix the thing it names — does not, and five codes would only be five ways
   * to render the same button state.
   */
  | 'NOT_RUNNABLE'
  /**
   * `unplaceComponent` could not tear a placement down: the Target is not
   * connected, this installation has no adapter for it, or the adapter's
   * `destroy` itself threw. One code for all three, the same argument
   * `NOT_RUNNABLE` makes — the sentence differs, the operator's next move
   * (read it, fix the thing it names, try again) does not.
   */
  | 'NOT_REMOVABLE'
  /** The caller saved an older revision than the server currently owns. */
  | 'STALE_EDIT';

/** The assertable identity of a failure, plus the sentence a user reads. */
export interface CommandFailure {
  readonly code: CommandFailureCode;
  /** The sentence the user reads. */
  readonly message: string;
  /** Field-level detail, where the failure has any. */
  readonly issues?: readonly CommandIssue[];
}

/** One thing wrong with one part of the input. */
export interface CommandIssue {
  /** Dotted path into the input object, empty for the object itself. */
  readonly path: string;
  readonly message: string;
}

/**
 * What every command returns.
 *
 * A refusal is a value, not an exception: the dispatch surface above this
 * layer has to turn a refusal into something a browser can render, and a
 * thrown error carries no code to render. Genuine faults — a database that is
 * gone — still throw, because they are not answers to the user's act.
 */
export type CommandResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly failure: CommandFailure };

/** Succeed with a value. */
export function ok<Output>(value: Output): CommandResult<Output> {
  return { ok: true, value };
}

/** Refuse, with an identity and a sentence. */
export function failed<Output>(
  code: CommandFailureCode,
  message: string,
  issues?: readonly CommandIssue[],
): CommandResult<Output> {
  return {
    ok: false,
    failure: issues ? { code, message, issues } : { code, message },
  };
}

/**
 * One user act.
 *
 * Every handler in `registry.ts` has this type, and the `satisfies` clause on
 * the registry object asserts that at compile time — which is what makes "no
 * route may contain domain logic" enforceable rather than aspirational.
 */
export type Command<Input, Output> = (
  input: Input,
  context: CommandContext,
) => Promise<CommandResult<Output>>;
