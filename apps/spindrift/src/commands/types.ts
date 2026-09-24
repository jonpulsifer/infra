/**
 * The command layer: one function per user act, taking its input and a
 * {@link CommandContext}. `registry.ts` maps each name to its command.
 */
import type { BuildAdapter } from '../adapters/build/contract.ts';
import type { GcpDiscovery } from '../adapters/cloud-discovery.ts';
import type { CloudflareAccounts } from '../adapters/cloudflare.ts';
import type { DatastoreAdapter } from '../adapters/datastore/contract.ts';
import type { DeployAdapter } from '../adapters/deploy/contract.ts';
import type { DnsPublisher } from '../adapters/dns/contract.ts';
import type { SecretStore } from '../adapters/store/contract.ts';
import type {
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
 * Enrolled users have no roles; all are fully privileged. A command may branch
 * on `kind`, the credential the act arrived with.
 */
export interface Principal {
  /**
   * A users row id, or a fixed id for a system principal such as auto-deploy.
   */
  readonly id: string;
  readonly displayName: string;
  /** Set only by the request authenticators; absent means not a human. */
  readonly kind?: PrincipalKind;
}

/** `human` arrived with a browser session or a linked Gateway identity. */
export type PrincipalKind = 'human' | 'agent';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * Every outside system a command reaches, and what tests fake. A `null` lookup
 * means the installation lacks it, which a command reports as a refusal.
 */
export interface AdapterRegistry {
  deploy(adapter: TargetAdapter): DeployAdapter | null;
  /** Route names come from the installation's configuration. */
  build(route: string): BuildAdapter | null;
  /**
   * `null` for a store this installation cannot reach. A Target that reaches
   * only such stores cannot hold config.
   */
  store(adapter: StoreAdapter): SecretStore | null;
  datastore?(adapter: TargetAdapter): DatastoreAdapter | null;
  /** `null` without a repository integration; uploaded archives need none. */
  repository(): RepositoryHost | null;
  /** Immutable repository staging; `null` without a repository integration. */
  source?(): RepositorySourceStager | null;
  registryTransport?(): RegistryTransport | null;
  /** `null` without a database and keyring: no token is stored in the clear. */
  registryCredentials?(): RegistryCredentialStore | null;
  /** The OAuth connector, where the repository integration has one. */
  repositoryAuthorization?(): RepositoryAuthorization | null;
  /** Lists projects, buckets and signing keys an operator need not type. */
  discovery?(): GcpDiscovery | null;
  /** A connected account's zones, Workers subdomain and Pages projects. */
  cloudflare?(): CloudflareAccounts | null;
  functions?(): FunctionDeployers | null;
  /** `null` without a keyring: no environment is stored in the clear. */
  functionEnv?(): FunctionEnvSealer | null;
  /**
   * Publishes names for Targets whose platform names its own workload. `null`
   * when the manifest declares no control-plane Kubernetes Target to carry them.
   */
  dns?(): DnsPublisher | null;
  supplyChain(): SupplyChain;
}

/** All a command may reach besides its input; never `Bun.env` or a singleton. */
export interface CommandContext {
  readonly principal: Principal;
  readonly clock: Clock;
  readonly db: Database;
  readonly adapters: AdapterRegistry;
  readonly manifest: InstallationManifest;
}

/** Each code is one kind of refusal; `message` names the specific reason. */
export type CommandFailureCode =
  | 'UNKNOWN_COMMAND'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  /** Well-formed input the world refuses, such as a disconnected Target. */
  | 'NOT_DEPLOYABLE'
  | 'NOT_BUILDABLE'
  | 'NOT_RUNNABLE'
  | 'NOT_RESTARTABLE'
  | 'NOT_REMOVABLE'
  /** The caller saved an older revision than the server holds. */
  | 'STALE_EDIT'
  /** The credential this act arrived with may not perform it. */
  | 'FORBIDDEN';

export interface CommandFailure {
  readonly code: CommandFailureCode;
  /** Shown to the user as written. */
  readonly message: string;
  readonly issues?: readonly CommandIssue[];
}

export interface CommandIssue {
  /** Dotted path into the input object, empty for the object itself. */
  readonly path: string;
  readonly message: string;
}

/**
 * A refusal returns as a value so the browser can render its code. A fault such
 * as a lost database still throws.
 */
export type CommandResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly failure: CommandFailure };

export function ok<Output>(value: Output): CommandResult<Output> {
  return { ok: true, value };
}

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

export type Command<Input, Output> = (
  input: Input,
  context: CommandContext,
) => Promise<CommandResult<Output>>;
